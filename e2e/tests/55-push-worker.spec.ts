/**
 * CONTRACT-V6-PUSH §6: the installable app and its service worker.
 *
 * The worker registers under the app's CSP with no violation (the `cspGuard`
 * fixture fails the test on any), is served `no-cache` with the right type and
 * no SPA fallback, takes control at once, and — the point of keeping it free of
 * any cache — the reload-on-new-build check (lib/buildCheck.ts) still moves a
 * tab onto a new build after a deploy, and the new worker replaces the old one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baseUrl, freshServer, restartServer, WEB_DIR } from '../lib/server'
import { expect, expectConnected, personViaApi, test } from '../lib/trio'

test('the worker is served to update promptly, registers under the CSP and controls the page', async ({ browser, trio }) => {
  await freshServer()
  const sw = await fetch(`${baseUrl()}/sw.js`)
  expect(sw.status).toBe(200)
  expect(sw.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(sw.headers.get('cache-control')).toBe('no-cache')
  expect(await sw.text()).toContain("addEventListener('push'")
  const manifest = await fetch(`${baseUrl()}/manifest.webmanifest`)
  expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
  const body = (await manifest.json()) as { id: string; scope: string; start_url: string; display: string; icons: { purpose: string; sizes: string }[] }
  expect(body).toMatchObject({ id: '/', scope: '/', start_url: '/', display: 'standalone' })
  expect(body.icons.filter((i) => i.purpose === 'maskable').map((i) => i.sizes)).toEqual(['192x192', '512x512'])
  for (const icon of body.icons) expect((await fetch(`${baseUrl()}/icon-${icon.sizes.split('x')[0]}.png`)).status).toBe(200)

  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const worker = await ayse.page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return { scope: registration.scope, script: registration.active?.scriptURL }
  })
  expect(worker).toEqual({ scope: `${baseUrl()}/`, script: `${baseUrl()}/sw.js` })
  // clients.claim(): this very page, not just the next one.
  await expect.poll(() => ayse.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${baseUrl()}/sw.js`)
  // No fetch handler: API calls and the shell still come from the network.
  const shell = await ayse.page.evaluate(async () => (await fetch('/', { cache: 'no-store' })).headers.get('content-security-policy'))
  expect(shell).toContain("worker-src 'self' blob:")
})

test('a deploy still reloads a tab onto the new build, and the new worker takes over', async ({ browser, trio }) => {
  // A copy of the built client the test can "deploy" into.
  const dist = path.join(WEB_DIR, 'dist')
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trio-e2e-static-'))
  fs.cpSync(dist, staticDir, { recursive: true })
  await freshServer({ TRIO_STATIC_DIR: staticDir })

  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await expect.poll(() => ayse.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${baseUrl()}/sw.js`)
  const firstEntry = await ayse.page.evaluate(() => new URL(document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src).pathname)
  await ayse.page.evaluate(() => {
    ;(window as unknown as { __trioOldPage: boolean }).__trioOldPage = true
  })

  // The "new build": the entry script under a new hashed name, and a changed worker.
  const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
  const newEntry = firstEntry.replace(/\.js$/, '-next.js')
  fs.copyFileSync(path.join(staticDir, firstEntry), path.join(staticDir, newEntry))
  fs.writeFileSync(path.join(staticDir, 'index.html'), html.replace(firstEntry, newEntry))
  fs.appendFileSync(path.join(staticDir, 'sw.js'), '\nself.__trioBuild = 2\n')

  await restartServer()
  // The reconnect asks for index.html, sees a different entry and reloads.
  await expect.poll(() => ayse.page.evaluate(() => (window as unknown as { __trioOldPage?: boolean }).__trioOldPage ?? false), { timeout: 30_000 }).toBe(false)
  await expectConnected(ayse.page)
  expect(await ayse.page.evaluate(() => new URL(document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src).pathname)).toBe(newEntry)
  // The browser fetched the changed sw.js (no-cache) and the new worker is active.
  await expect
    .poll(async () => {
      for (const worker of ayse.context.serviceWorkers()) {
        if ((await worker.evaluate(() => (self as unknown as { __trioBuild?: number }).__trioBuild ?? 0).catch(() => 0)) === 2) return true
      }
      return false
    }, { timeout: 20_000 })
    .toBe(true)
  fs.rmSync(staticDir, { recursive: true, force: true })
})
