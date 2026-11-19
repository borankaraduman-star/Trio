/**
 * "Ana ekrana ekle" (CONTRACT-V6-PUSH §6). On iOS Safari there is no install
 * prompt to call and Web Push only works for a web app opened from the home
 * screen, so the card explains the two taps. Chromium (Android, desktop)
 * fires `beforeinstallprompt` when it considers the app installable; the card
 * then offers the browser's own dialog. The event is caught at import time
 * because it can fire before React has mounted anything.
 */

export const INSTALL_DISMISSED_KEY = 'trio.installCard.dismissed'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallMode = 'ios' | 'prompt' | null

/** Which card to show (pure). */
export function installMode(input: { ios: boolean; standalone: boolean; promptReady: boolean; dismissed: boolean }): InstallMode {
  if (input.standalone || input.dismissed) return null
  if (input.ios) return 'ios'
  return input.promptReady ? 'prompt' : null
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault() // our card asks instead of the browser's mini-infobar
    deferred = event as InstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    emit()
  })
}

export const installPrompt = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  ready: (): boolean => deferred !== null,
  async show(): Promise<boolean> {
    const event = deferred
    if (!event) return false
    deferred = null
    emit()
    await event.prompt()
    return (await event.userChoice).outcome === 'accepted'
  },
}

export function installDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissInstall(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
  } catch {
    // not remembered: the card comes back next time
  }
}
