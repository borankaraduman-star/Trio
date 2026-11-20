import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { comboFromEvent, comboLabel, setBinding } from '../../lib/hotkeys'
import { isBindableKey, keyLabel, settingsStore } from '../../settings'
import { voicePrefsStore } from '../../lib/voicePrefs'
import { desktopBridge, type WatchHotkeyAction } from '../../ptt'
import { WATCH_ACTION_LABELS, WATCH_ACTIONS } from '../../watching/actions'
import { SUGGESTED_WATCH_KEYS, watchKeyRefusal } from '../../watching/keys'
import { desktopMini, documentPipAvailable } from '../../watching/mini'
import { useWatch, watchStore } from '../../watching/store'

/**
 * Ayarlar › Görüntü › "Paylaşım izlerken" (CONTRACT-V12-WATCHING §9): the
 * automatic mini player, its opacity and content protection (desktop app),
 * light watching while a game runs, the receiving line, the notice.
 */
export function WatchSettingsSection() {
  const watch = useWatch()
  const desktop = desktopMini() !== null
  const toggle = (key: 'autoMini' | 'lightInGame' | 'stats' | 'notifyShare' | 'miniContentProtection', label: string, hint: string) => (
    <label className="settings-toggle">
      <input
        type="checkbox"
        data-testid={`watch-setting-${key}`}
        checked={watch[key]}
        onChange={(event) => {
          watchStore.update({ [key]: event.target.checked })
          if (key === 'notifyShare' && event.target.checked && typeof Notification === 'function' && Notification.permission === 'default') {
            void Notification.requestPermission().catch(() => undefined)
          }
        }}
      />
      <span>
        {label}
        <small className="settings-hint">{hint}</small>
      </span>
    </label>
  )
  return (
    <section className="settings-section" aria-labelledby="settings-watching" data-testid="settings-watching">
      <h3 id="settings-watching">Paylaşım izlerken</h3>
      {toggle(
        'autoMini',
        'Trio arka plandayken paylaşılan ekranı mini oynatıcıda göster',
        desktop
          ? 'Trio küçültülünce ya da tepsiye inince izlediğin paylaşım köşede, oyunun üstünde açılır; Trio\'ya dönünce kapanır. Özel tam ekran (exclusive fullscreen) oyunların üstünde hiçbir pencere duramaz: oyunu "pencereli tam ekran / borderless" yap.'
          : documentPipAvailable()
            ? 'Sekmeden çıkınca tarayıcı izin verirse paylaşım her şeyin üstünde duran küçük bir pencerede açılır.'
            : 'Bu tarayıcı bunu kendiliğinden yapamıyor; mini oynatıcıyı paylaşımın üstündeki düğmeyle açabilirsin.',
      )}
      {desktop && (
        <label className="settings-field">
          <span className="settings-label">Mini oynatıcı saydamlığı</span>
          <input
            type="range"
            min={40}
            max={100}
            step={5}
            data-testid="watch-setting-opacity"
            value={Math.round(watch.miniOpacity * 100)}
            onChange={(event) => watchStore.update({ miniOpacity: Number(event.target.value) / 100 })}
          />
          <span>%{Math.round(watch.miniOpacity * 100)}</span>
        </label>
      )}
      {desktop &&
        toggle(
          'miniContentProtection',
          'Kendi paylaşımımda gizle',
          'Sen de ekran paylaşırken mini oynatıcı senin paylaşımında görünmez. Ekran kaydı programları da onu göremez; eski Windows 10 sürümlerinde yerine siyah bir kutu görünebilir.',
        )}
      {toggle(
        'lightInGame',
        'Oyun açıkken hafif izle',
        'Oyun durumun "oynuyor" iken her paylaşım sana küçük ve saniyede birkaç kare gönderilir: işlemci ve hat oyuna kalır.',
      )}
      {toggle('stats', 'Bağlantı bilgisini göster', 'Her paylaşımın üstünde gelen çözünürlük, kare/sn ve hız.')}
      {toggle(
        'notifyShare',
        'Biri paylaşmaya başlayınca bildir',
        'Trio arka plandayken sessiz bir sistem bildirimi; "Rahatsız etme" açıkken gelmez.',
      )}
    </section>
  )
}

/** Ayarlar › Kısayollar › İzlerken: one binder per watching action. */
export function WatchShortcutsSection() {
  const watch = useWatch()
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
  const bridge = desktopBridge()
  const desktop = typeof bridge?.setWatchHotkeys === 'function'
  const keys = desktop ? watch.desktopKeys : watch.pageKeys
  const taken = {
    ptt: settings.inputMode === 'ptt' ? settings.pttKey : null,
    mute: desktop ? prefs.desktopHotkeys.mute : prefs.pageShortcuts.mute,
    deafen: desktop ? prefs.desktopHotkeys.deafen : prefs.pageShortcuts.deafen,
  }
  const [refused, setRefused] = useState<string | null>(null)
  const actions = desktop ? WATCH_ACTIONS : WATCH_ACTIONS.filter((action) => action !== 'clickThrough')

  const bind = (action: WatchHotkeyAction, value: string | null) => {
    const next = { ...keys, [action]: value }
    const why = value === null ? null : watchKeyRefusal(next, action, taken)
    if (why) {
      setRefused(why)
      return
    }
    setRefused(null)
    watchStore.update(desktop ? { desktopKeys: next } : { pageKeys: next })
  }

  return (
    <section className="settings-section" aria-labelledby="settings-watch-keys" data-testid="settings-watch-keys" data-desktop={desktop}>
      <h3 id="settings-watch-keys">İzlerken</h3>
      {actions.map((action) => (
        <WatchKeyBinder
          key={action}
          action={action}
          label={WATCH_ACTION_LABELS[action]}
          value={keys[action]}
          desktop={desktop}
          refusal={watchKeyRefusal(keys, action, taken)}
          onBind={(value) => bind(action, value)}
        />
      ))}
      {refused && (
        <p className="form-error" role="alert" data-testid="watch-key-conflict">
          {refused}
        </p>
      )}
      <p className="settings-hint">
        {desktop
          ? `Hiçbiri atanmış değil: oyunlar çoğu tuşu kullanır. Önerilen: mini oynatıcı ${comboLabel(SUGGESTED_WATCH_KEYS.toggleMini ?? '')}, tıklamaları geçir ${comboLabel(SUGGESTED_WATCH_KEYS.clickThrough ?? '')}, sıradaki paylaşım ${comboLabel(SUGGESTED_WATCH_KEYS.nextShare ?? '')}. Ctrl+Alt ile harf seçme (Türkçe klavyede AltGr'dır, oyun sohbetinde @ ve € yazar).`
          : 'Tarayıcıda bu kısayollar yalnız Trio sekmesi öndeyken çalışır; oyun oynarken çalışanlar masaüstü uygulamasında atanır.'}
      </p>
    </section>
  )
}

function WatchKeyBinder({
  action,
  label,
  value,
  desktop,
  refusal,
  onBind,
}: {
  action: WatchHotkeyAction
  label: string
  value: string | null
  desktop: boolean
  refusal: string | null
  onBind: (value: string | null) => void
}) {
  const [listening, setListening] = useState(false)
  const bind = useRef(onBind)
  bind.current = onBind
  useEffect(() => {
    if (!listening) return
    setBinding(true)
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'Escape') {
        setListening(false)
        return
      }
      // A chord (Ctrl/Alt/Meta + key) everywhere; in the desktop app a single key too.
      const chord = comboFromEvent(event)
      const plain = desktop && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isBindableKey(event.code) ? event.code : null
      const next = chord ?? plain
      if (next === null) return
      bind.current(next)
      setListening(false)
    }
    const onBlur = () => setListening(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      setBinding(false)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [listening, desktop])
  const shown = value === null ? 'Yok' : value.includes('+') ? comboLabel(value) : keyLabel(value)
  return (
    <div className="settings-field shortcut-row">
      <span className="settings-label">{label}</span>
      <div className="key-binder">
        <kbd data-testid={`watch-key-${action}`} title={refusal ?? undefined} className={refusal ? 'refused' : undefined}>
          {shown}
        </kbd>
        <button type="button" className={listening ? 'primary' : 'ghost'} data-testid={`watch-key-${action}-bind`} onClick={() => setListening((on) => !on)}>
          {listening ? 'Bir tuşa bas… (Esc)' : 'Değiştir'}
        </button>
        {value !== null && !listening && (
          <button type="button" className="ghost" data-testid={`watch-key-${action}-clear`} onClick={() => bind.current(null)}>
            Kaldır
          </button>
        )}
      </div>
    </div>
  )
}
