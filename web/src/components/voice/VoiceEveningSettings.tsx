import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { linearToDb } from '../../audio/gateCore'
import { micConstraints } from '../../audio/pipeline'
import { useActiveEngine } from '../../lib/activeVoice'
import { desktopHotkeysSupported } from '../../lib/desktopVoice'
import { comboFromEvent, comboLabel, hotkeyConflict, setBinding, type HotkeyAction } from '../../lib/hotkeys'
import { GATE_MAX_DB, GATE_MIN_DB, voicePrefsStore } from '../../lib/voicePrefs'
import { isBindableKey, keyLabel, settingsStore } from '../../settings'

const METER_MS = 100
/** The bar falls at most this many dB per reading: a word reads as one bar, not a flicker. */
const FALL_DB = 4

function withFall(shown: number, now: number): number {
  if (!Number.isFinite(shown)) return now
  return Math.max(now, shown - FALL_DB)
}

/** dBFS → position on the bar (0..1), over the threshold's own range. */
function barPosition(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.min(1, Math.max(0, (db - GATE_MIN_DB) / (GATE_MAX_DB - GATE_MIN_DB)))
}

/** The microphone's level for the bar: the call's own (after RNNoise, before the gate), else a test stream. */
function useInputLevel(testing: boolean): { db: number; source: 'call' | 'test' | null } {
  const engine = useActiveEngine()
  const voice = useSyncExternalStore(
    (listener) => engine?.subscribe(listener) ?? (() => undefined),
    () => engine?.getSnapshot() ?? null,
  )
  const inCall = voice !== null && voice.status !== 'idle'
  const [db, setDb] = useState(-Infinity)
  const micId = useSyncExternalStore(settingsStore.subscribe, () => settingsStore.getSnapshot().micDeviceId)

  useEffect(() => {
    if (!inCall || !engine) return
    const timer = setInterval(() => {
      const peak = engine.inputPeak()
      setDb((shown) => withFall(shown, peak === null ? -Infinity : linearToDb(peak)))
    }, METER_MS)
    return () => clearInterval(timer)
  }, [inCall, engine])

  useEffect(() => {
    if (inCall || !testing) return
    let stopped = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia(micConstraints(micId, true))
        if (stopped) return
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 4096
        context.createMediaStreamSource(stream).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v))
          setDb((shown) => withFall(shown, linearToDb(peak)))
        }, METER_MS)
      } catch {
        setDb(-Infinity)
      }
    })()
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      for (const track of stream?.getTracks() ?? []) track.stop()
      if (context) void context.close().catch(() => undefined)
    }
  }, [inCall, testing, micId])

  return { db, source: inCall ? 'call' : testing ? 'test' : null }
}

/** Ayarlar › Giriş hassasiyeti (CONTRACT-V6-VOICE §4): a live level bar with a draggable threshold. */
export function InputSensitivitySection() {
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const engine = useActiveEngine()
  const voice = useSyncExternalStore(
    (listener) => engine?.subscribe(listener) ?? (() => undefined),
    () => engine?.getSnapshot() ?? null,
  )
  const [testing, setTesting] = useState(false)
  const level = useInputLevel(testing)
  const above = Number.isFinite(level.db) && level.db >= prefs.gateThresholdDb
  const inCall = voice !== null && voice.status !== 'idle'
  const gateState = voice?.gateState ?? 'off'
  return (
    <section className="settings-section" aria-labelledby="settings-sensitivity">
      <h3 id="settings-sensitivity">Giriş hassasiyeti</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="gate-auto"
          checked={prefs.gateAuto}
          onChange={(event) => voicePrefsStore.update({ gateAuto: event.target.checked })}
        />
        <span>
          Otomatik
          <small className="settings-hint">
            {prefs.gateAuto
              ? 'Mikrofon hep açık; sessizlikleri gürültü engelleme süzer.'
              : 'Ses eşiğin altındayken hiçbir şey gönderilmez. Çubuğu konuşurken yeşile, susarken griye düşecek yere çek.'}
          </small>
        </span>
      </label>
      <div
        className={`gate-meter${prefs.gateAuto ? ' auto' : ''}`}
        data-testid="gate-meter"
        data-level-db={Number.isFinite(level.db) ? Math.round(level.db) : ''}
        data-above={above}
        data-gate-state={gateState}
        data-gate-open={voice?.gateOpen ?? true}
      >
        <span className="gate-meter-fill" style={{ width: `${barPosition(level.db) * 100}%` }} data-above={above} />
        {!prefs.gateAuto && (
          <span className="gate-meter-mark" style={{ left: `${barPosition(prefs.gateThresholdDb) * 100}%` }} aria-hidden="true" />
        )}
        <input
          type="range"
          aria-label="Giriş eşiği (dB)"
          data-testid="gate-threshold"
          min={GATE_MIN_DB}
          max={GATE_MAX_DB}
          step={1}
          value={prefs.gateThresholdDb}
          disabled={prefs.gateAuto}
          onChange={(event) => voicePrefsStore.update({ gateThresholdDb: Number(event.target.value) })}
        />
      </div>
      <p className="settings-hint gate-readout">
        {prefs.gateAuto ? 'Eşik yok' : `Eşik ${prefs.gateThresholdDb} dB`}
        {level.source !== null && Number.isFinite(level.db) && ` · şu an ${Math.round(level.db)} dB`}
        {inCall && gateState === 'unavailable' && ' · eşik yüklenemedi, mikrofon eşiksiz gönderiliyor'}
      </p>
      {!inCall && (
        <button
          type="button"
          className="ghost"
          data-testid="gate-meter-test"
          aria-pressed={testing}
          onClick={() => setTesting((value) => !value)}
        >
          {testing ? 'Seviyeyi durdur' : 'Mikrofon seviyesini göster'}
        </button>
      )}
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="afk-enabled"
          checked={prefs.afkEnabled}
          onChange={(event) => voicePrefsStore.update({ afkEnabled: event.target.checked })}
        />
        <span>
          10 dakika hareketsiz kalınca AFK ol
          <small className="settings-hint">
            Konuşmadığın ve hiçbir tuşa dokunmadığın 10 dakikadan sonra adının yanında AFK görünür ve mikrofonun kapanır;
            döndüğünde (bir tuş, fare ya da konuşma) kendiliğinden açılır. Kendin kapattığın mikrofon kapalı kalır.
          </small>
        </span>
      </label>
    </section>
  )
}

/** Press-to-bind one shortcut. `chord`: an in-page Ctrl/Alt chord; else a single global key. */
function ShortcutBinder({
  action,
  label,
  value,
  chord,
  onBind,
}: {
  action: HotkeyAction
  label: string
  value: string | null
  chord: boolean
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
      const next = chord ? comboFromEvent(event) : isBindableKey(event.code) ? event.code : null
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
  }, [listening, chord])
  return (
    <div className="settings-field shortcut-row">
      <span className="settings-label">{label}</span>
      <div className="key-binder">
        <kbd data-testid={`shortcut-${action}`}>{value === null ? 'Yok' : chord ? comboLabel(value) : keyLabel(value)}</kbd>
        <button
          type="button"
          className={listening ? 'primary' : 'ghost'}
          data-testid={`shortcut-${action}-bind`}
          onClick={() => setListening((on) => !on)}
        >
          {listening ? (chord ? 'Ctrl/Alt ile bir tuşa bas… (Esc)' : 'Bir tuşa bas… (Esc)') : 'Değiştir'}
        </button>
        {value !== null && !listening && (
          <button type="button" className="ghost" data-testid={`shortcut-${action}-clear`} onClick={() => bind.current(null)}>
            Kaldır
          </button>
        )}
      </div>
    </div>
  )
}

/** Ayarlar › Kısayollar (CONTRACT-V6-VOICE §5). */
export function ShortcutsSection() {
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
  const desktop = desktopHotkeysSupported()
  const ptt = settings.inputMode === 'ptt' ? settings.pttKey : null
  const [refused, setRefused] = useState<string | null>(null)
  const keys = desktop ? prefs.desktopHotkeys : prefs.pageShortcuts
  const standing = desktop ? hotkeyConflict({ ptt, mute: keys.mute, deafen: keys.deafen }) : null

  const bind = useCallback(
    (action: HotkeyAction, value: string | null) => {
      const next = { ...keys, [action]: value }
      const conflict = desktop
        ? hotkeyConflict({ ptt: settingsStore.getSnapshot().inputMode === 'ptt' ? settingsStore.getSnapshot().pttKey : null, ...next })
        : value !== null && next.mute === next.deafen
          ? 'Sessize alma ve kulaklık aynı kısayol olamaz.'
          : null
      if (conflict) {
        setRefused(conflict)
        return
      }
      setRefused(null)
      voicePrefsStore.update(desktop ? { desktopHotkeys: next } : { pageShortcuts: next })
    },
    [desktop, keys],
  )

  return (
    <section className="settings-section" aria-labelledby="settings-shortcuts" data-testid="settings-shortcuts" data-desktop={desktop}>
      <h3 id="settings-shortcuts">Kısayollar</h3>
      <ShortcutBinder action="mute" label="Sessize al / aç" value={keys.mute} chord={!desktop} onBind={(v) => bind('mute', v)} />
      <ShortcutBinder action="deafen" label="Kulaklığı kapat / aç" value={keys.deafen} chord={!desktop} onBind={(v) => bind('deafen', v)} />
      {(refused ?? standing) && (
        <p className="form-error" role="alert" data-testid="shortcut-conflict">
          {refused ?? standing}
        </p>
      )}
      <p className="settings-hint">
        {desktop
          ? 'Masaüstü uygulamasında bu tuşlar pencere arkadayken de (oyundayken) çalışır. Bas-konuş tuşu kısayol olamaz.'
          : 'Tarayıcıda kısayollar yalnız bu sekme öndeyken çalışır. Masaüstü uygulamasında her yerden çalışan tuşlar atanabilir.'}
      </p>
    </section>
  )
}
