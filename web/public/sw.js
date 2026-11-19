/* Trio's service worker: Web Push and notification clicks, nothing else.
 *
 * CONTRACT-V6-PUSH §6. Deliberately NO fetch handler and NO cache of the app
 * shell or the API: Trio is online-only, the server sends index.html with
 * `Cache-Control: no-cache`, and lib/buildCheck.ts reloads a tab that is
 * running an old build after a deploy. A caching worker would serve the old
 * index.html and bring back exactly the stale-client problem that check exists
 * to prevent. Without a fetch handler every request goes to the network as if
 * there were no worker.
 *
 * Updates: /sw.js is served `no-cache`; skipWaiting + clients.claim make a new
 * worker take over at once (it holds no state that an old page depends on).
 *
 * Plain JavaScript in public/ (copied as is, not bundled): the browser fetches
 * it by a fixed name, and a hashed bundle name would change the registration.
 */
'use strict'

const MESSAGE_TAG = /^ch-(\d+)$/

/**
 * getNotifications() is only asked when notifications are allowed: there is
 * nothing to list otherwise, and Chromium's headless shell (the e2e suite's
 * browser) crashes the page when a worker asks without the permission.
 */
function allowed() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function parse(event) {
  try {
    const data = event.data ? event.data.json() : null
    if (data && typeof data === 'object' && typeof data.title === 'string') return data
  } catch {
    // fall through: a push must always show something (Safari revokes otherwise)
  }
  return { v: 1, kind: 'unknown', title: 'Trio', body: 'Yeni bildirim', tag: 'trio' }
}

/** The badge: the per-channel counts of the message notifications shown, summed. */
function countOf(list) {
  let total = 0
  for (const n of list) if (MESSAGE_TAG.test(n.tag)) total += (n.data && n.data.count) || 1
  return total
}

async function setBadge(total) {
  const nav = self.navigator
  if (!nav || typeof nav.setAppBadge !== 'function') return
  try {
    if (total > 0) await nav.setAppBadge(total)
    else await nav.clearAppBadge()
  } catch {
    // badging not allowed (iOS setting): nothing to do
  }
}

async function refreshBadge() {
  if (!allowed()) return
  await setBadge(countOf(await self.registration.getNotifications()))
}

async function show(data) {
  const tag = typeof data.tag === 'string' && data.tag ? data.tag.slice(0, 64) : 'trio'
  let title = data.title
  let body = typeof data.body === 'string' ? data.body : ''
  let count = 1
  // Everything shown is read BEFORE showing, never right after: Chromium drops
  // a notification from getNotifications() (for good) when it is read while
  // its display is still being completed, which a read just after
  // showNotification() resolves can hit.
  const before = allowed() ? await self.registration.getNotifications() : []
  const existing = before.filter((n) => n.tag === tag)
  if (MESSAGE_TAG.test(tag)) {
    const previous = existing.length > 0 && existing[0].data ? existing[0].data.count || 1 : 0
    count = previous + 1
    if (count > 1) {
      title = data.channel ? `#${data.channel}` : title
      body = `${count} yeni mesaj · ${data.author ? `${data.author}: ` : ''}${body}`
    }
  }
  await self.registration.showNotification(title, {
    body,
    tag,
    // Only a mention (and a ring) makes a collapsed notification buzz again.
    renotify: data.renotify === true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    lang: 'tr',
    data: {
      kind: data.kind,
      channel_id: typeof data.channel_id === 'number' ? data.channel_id : null,
      message_id: typeof data.message_id === 'number' ? data.message_id : null,
      count,
    },
  })
  if (MESSAGE_TAG.test(tag)) await setBadge(countOf(before.filter((n) => n.tag !== tag)) + count)
}

self.addEventListener('push', (event) => {
  event.waitUntil(show(parse(event)))
})

/** Focus a Trio window and send it to the channel / room; open one if none. */
async function openFor(data) {
  const channelId = data && typeof data.channel_id === 'number' ? data.channel_id : null
  const kind = (data && data.kind) || 'unknown'
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const best = windows.find((c) => c.focused) || windows.find((c) => c.visibilityState === 'visible') || windows[0]
  if (best) {
    best.postMessage({ type: 'trio.open', channel_id: channelId, kind })
    try {
      await best.focus()
    } catch {
      // focus() is only allowed while handling a click; the message still routes it
    }
    return best.id
  }
  const query = channelId === null ? '' : `?open=${channelId}&kind=${encodeURIComponent(kind)}`
  const opened = await self.clients.openWindow(`/${query}`)
  return opened ? opened.id : null
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(Promise.all([openFor(event.notification.data), refreshBadge()]))
})

self.addEventListener('notificationclose', (event) => {
  event.waitUntil(refreshBadge())
})

/** The page asks: it is being viewed, so the message notifications and the badge go. */
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'trio.viewed' && allowed()) {
    event.waitUntil(
      (async () => {
        const shown = await self.registration.getNotifications()
        for (const n of shown) if (MESSAGE_TAG.test(n.tag)) n.close()
        await refreshBadge()
      })(),
    )
  }
})

/**
 * The browser replaced the subscription (expiry, key rotation). Subscribe again
 * with the same server key; the page sends the new one to the server the next
 * time it runs (lib/notify/pushClient.ts `sync`), because this worker has no
 * token to sign a request with — and is not given one on purpose.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription
      const key = old && old.options ? old.options.applicationServerKey : null
      if (!event.newSubscription && key) {
        try {
          await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        } catch {
          return
        }
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of windows) c.postMessage({ type: 'trio.subscription-changed' })
    })(),
  )
})

// For the e2e suite and for debugging from DevTools: the click path without a click.
self.trio = { openFor, show }
