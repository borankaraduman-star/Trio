/**
 * What this browser can do about notifications, and what the settings screen
 * says about it (CONTRACT-V6-PUSH §6). Pure: `probeEnvironment` reads the real
 * browser, everything else is a function of its answer, so the states are
 * unit-tested.
 */

export interface NotifyEnvironment {
  /** `window.Notification` exists. */
  notification: boolean
  serviceWorker: boolean
  pushManager: boolean
  /** https or localhost: service workers and push need it. */
  secure: boolean
  /** iPhone/iPad (including iPadOS that claims to be a Mac). */
  ios: boolean
  /** Opened from the home screen / installed (display-mode standalone). */
  standalone: boolean
  permission: NotificationPermission | null
}

export type NotifyState =
  /** iOS Safari in a tab: Web Push exists only for a web app added to the home screen. */
  | 'ios-needs-home-screen'
  /** Plain http (not localhost): no service worker, no push. */
  | 'insecure'
  /** No Notification / service worker / Push API at all. */
  | 'unsupported'
  /** Notifications can be shown, but this browser cannot receive pushes. */
  | 'no-push'
  | 'default'
  | 'denied'
  | 'granted'

export function notifyState(env: NotifyEnvironment): NotifyState {
  if (env.ios && !env.standalone) return 'ios-needs-home-screen'
  if (!env.secure) return 'insecure'
  if (!env.notification || env.permission === null) return env.ios ? 'ios-needs-home-screen' : 'unsupported'
  if (env.permission === 'denied') return 'denied'
  if (!env.serviceWorker || !env.pushManager) return env.permission === 'granted' ? 'no-push' : 'default'
  return env.permission === 'granted' ? 'granted' : 'default'
}

/** Whether "Bu cihazda bildir" can be switched on from this state (asking first if need be). */
export function canEnablePush(state: NotifyState, env: Pick<NotifyEnvironment, 'serviceWorker' | 'pushManager'>): boolean {
  return (state === 'default' || state === 'granted') && env.serviceWorker && env.pushManager
}

export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'other'

export function platformOf(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios' // iPadOS asks for desktop sites
  if (/Android/.test(userAgent)) return 'android'
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux|CrOS/.test(userAgent)) return 'linux'
  return 'other'
}

export type UaFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'opera' | 'electron' | 'other'

export function uaFamily(userAgent: string): UaFamily {
  if (/Electron\//.test(userAgent)) return 'electron'
  if (/SamsungBrowser\//.test(userAgent)) return 'samsung'
  if (/Edg(A|iOS)?\//.test(userAgent)) return 'edge'
  if (/OPR\//.test(userAgent)) return 'opera'
  if (/Firefox\/|FxiOS\//.test(userAgent)) return 'firefox'
  if (/Chrome\/|CriOS\//.test(userAgent)) return 'chrome'
  if (/Safari\//.test(userAgent)) return 'safari'
  return 'other'
}

const PLATFORM_NAME: Record<Platform, string> = {
  ios: 'iPhone/iPad',
  android: 'Android',
  mac: 'Mac',
  windows: 'Windows',
  linux: 'Linux',
  other: 'Cihaz',
}
const FAMILY_NAME: Record<UaFamily, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  samsung: 'Samsung Internet',
  opera: 'Opera',
  electron: 'Trio masaüstü',
  other: 'tarayıcı',
}

/** "Android · Chrome": the label a new device gets until it is renamed. */
export function defaultDeviceLabel(userAgent: string, maxTouchPoints = 0): string {
  return `${PLATFORM_NAME[platformOf(userAgent, maxTouchPoints)]} · ${FAMILY_NAME[uaFamily(userAgent)]}`
}

/** The settings screen's explanation for a state (one or two sentences, Turkish). */
export function stateExplanation(state: NotifyState, platform: Platform): string {
  switch (state) {
    case 'ios-needs-home-screen':
      return 'iPhone ve iPad’de bildirimler yalnızca Trio ana ekrana eklenip oradan açılınca çalışır (iOS 16.4 ve sonrası). Safari’de Paylaş → Ana Ekrana Ekle, sonra Trio’yu ana ekrandan aç.'
    case 'insecure':
      return 'Bildirimler yalnızca güvenli (https) bağlantıda çalışır. Trio’yu https adresinden aç.'
    case 'unsupported':
      return 'Bu tarayıcı bildirimleri desteklemiyor. Chrome, Edge, Firefox ya da Safari’nin güncel sürümünü dene.'
    case 'no-push':
      return 'Bu tarayıcı sekme açıkken bildirim gösterebilir, ama kapalıyken bildirim alamaz.'
    case 'default':
      return 'Trio kapalıyken de yeni mesajlardan, çağrılardan ve ses odasına girenlerden haberin olsun.'
    case 'denied':
      if (platform === 'android')
        return 'Bildirim izni reddedilmiş. Adres çubuğundaki kilit simgesi → İzinler → Bildirimler → İzin ver; uygulama olarak eklediysen Ayarlar → Uygulamalar → Trio → Bildirimler.'
      if (platform === 'ios')
        return 'Bildirim izni reddedilmiş. iPhone Ayarlar → Bildirimler → Trio → Bildirimlere İzin Ver.'
      if (platform === 'mac')
        return 'Bildirim izni reddedilmiş. Adres çubuğundaki site ayarlarından bildirimlere izin ver; macOS Sistem Ayarları → Bildirimler’de tarayıcının da açık olduğunu kontrol et.'
      return 'Bildirim izni reddedilmiş. Adres çubuğundaki kilit ya da site ayarları simgesinden bildirimlere izin ver, sonra sayfayı yenile.'
    case 'granted':
      return 'Bildirim izni verildi.'
  }
}

export function probeEnvironment(): NotifyEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const win = typeof window === 'undefined' ? undefined : window
  const hasNotification = typeof Notification !== 'undefined'
  const ua = nav?.userAgent ?? ''
  let standalone = false
  try {
    standalone =
      win?.matchMedia?.('(display-mode: standalone)').matches === true ||
      (nav as unknown as { standalone?: boolean } | undefined)?.standalone === true
  } catch {
    standalone = false
  }
  return {
    notification: hasNotification,
    serviceWorker: !!nav && 'serviceWorker' in nav,
    pushManager: !!win && 'PushManager' in win,
    secure: win?.isSecureContext === true,
    ios: platformOf(ua, nav?.maxTouchPoints ?? 0) === 'ios',
    standalone,
    permission: hasNotification ? Notification.permission : null,
  }
}
