import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { notifyHub } from '../../lib/notify/notifyHub'
import { canEnablePush, stateExplanation } from '../../lib/notify/permission'
import type { Level, PushDevice } from '../../lib/notify/pushApi'
import { browserTimeZone, inQuietHours, isHhMm } from '../../lib/notify/quietHours'
import { LEVEL_LABELS } from './ChannelNotifyMenu'

function zones(current: string): string[] {
  const listed = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  return [...new Set([current, browserTimeZone(), 'Europe/Istanbul', ...listed])]
}

function when(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function DeviceRow({ device, here }: { device: PushDevice; here: boolean }) {
  const status = device.last_error
    ? `Son deneme başarısız: ${device.last_error}`
    : device.last_ok_at
      ? `Son bildirim: ${when(device.last_ok_at)}`
      : 'Henüz bildirim gönderilmedi'
  return (
    <li className="notify-device" data-testid="notify-device" data-here={here}>
      <span className="notify-device-name">
        <span className="notify-device-label">
          {device.label}
          {here && <span className="notify-here-badge">bu cihaz</span>}
        </span>
        <small className={device.last_error ? 'settings-hint notify-error' : 'settings-hint'}>{status}</small>
      </span>
      <button
        type="button"
        className="ghost"
        data-testid={`notify-device-remove-${device.id}`}
        aria-label={`${device.label} cihazını kaldır`}
        onClick={() => void notifyHub.removeDevice(device.id)}
      >
        Kaldır
      </button>
    </li>
  )
}

/** Ayarlar › Bildirimler (CONTRACT-V6-PUSH §6). Everything here lives on the server. */
export function NotificationsSection() {
  const notify = useSyncExternalStore(notifyHub.subscribe, notifyHub.getSnapshot)
  const [, setTick] = useState(0)
  useEffect(() => {
    notifyHub.reprobe()
    void notifyHub.loadDevices()
    void notifyHub.publicKey() // fetched before the click: subscribing needs no wait then
    const timer = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])
  const { state, env, prefs, devices, thisDeviceId, busy, error, test } = notify
  const pushable = canEnablePush(state, env)
  const channels = notifyHub.channels()
  const quiet = prefs?.quiet
  const zoneList = useMemo(() => zones(quiet?.tz ?? browserTimeZone()), [quiet?.tz])
  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)

  return (
    <section className="settings-section notify-section" aria-labelledby="settings-notify" data-testid="settings-notify">
      <h3 id="settings-notify">Bildirimler</h3>
      <p className={`notify-state notify-state-${state}`} data-testid="notify-state" data-state={state}>
        {stateExplanation(state, notify.platform)}
      </p>
      {state === 'default' && pushable && thisDeviceId === null && (
        <button
          type="button"
          className="primary"
          data-testid="notify-allow"
          disabled={busy}
          onClick={() => void notifyHub.enableHere()}
        >
          Bildirimlere izin ver
        </button>
      )}

      {(state === 'granted' || (state === 'default' && thisDeviceId !== null)) && (
        <label className="settings-toggle">
          <input
            type="checkbox"
            data-testid="notify-here"
            checked={thisDeviceId !== null}
            disabled={busy || !pushable}
            onChange={(event) => void (event.target.checked ? notifyHub.enableHere() : notifyHub.disableHere())}
          />
          <span>
            Bu cihazda bildir
            <small className="settings-hint">
              {thisDeviceId !== null
                ? 'Trio kapalıyken de bu cihaza bildirim gelir. Uygulamaya bakarken gelmez.'
                : 'Kapalı: bu cihaz yalnızca Trio açıkken bildirim gösterir.'}
            </small>
          </span>
        </label>
      )}
      {error && (
        <p className="notify-error" role="alert" data-testid="notify-error">
          {error}
        </p>
      )}
      {thisDeviceId !== null && (
        <div className="notify-test">
          <button
            type="button"
            className="ghost notify-test-button"
            data-testid="notify-test"
            disabled={test?.sending === true}
            onClick={() => void notifyHub.sendTest()}
          >
            Deneme bildirimi gönder
          </button>
          {test && (
            <p className={test.ok === false ? 'settings-hint notify-error' : 'settings-hint'} data-testid="notify-test-result" data-ok={test.ok ?? ''} aria-live="polite">
              {test.text}
            </p>
          )}
        </div>
      )}

      {devices && devices.length > 0 && (
        <div className="settings-field">
          <span className="settings-label">Bildirim alan cihazlar</span>
          <ul className="notify-devices" data-testid="notify-devices">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} here={device.id === thisDeviceId} />
            ))}
          </ul>
        </div>
      )}

      {prefs && (
        <>
          <div className="settings-field">
            <span className="settings-label">Kanallar</span>
            <ul className="notify-levels">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <label htmlFor={`notify-level-${channel.id}`}>
                    {channel.kind === 'text' ? '#' : '🔊 '}
                    {channel.name}
                  </label>
                  <select
                    id={`notify-level-${channel.id}`}
                    data-testid={`notify-level-${channel.id}`}
                    value={prefs.channels[String(channel.id)] ?? 'all'}
                    onChange={(event) =>
                      void notifyHub.savePrefs({ channels: { [String(channel.id)]: event.target.value as Level } })
                    }
                  >
                    {(Object.keys(LEVEL_LABELS) as Level[])
                      .filter((level) => channel.kind === 'text' || level !== 'mentions')
                      .map((level) => (
                        <option key={level} value={level}>
                          {LEVEL_LABELS[level]}
                        </option>
                      ))}
                  </select>
                </li>
              ))}
            </ul>
            <small className="settings-hint">“Yalnız @ben”: yalnızca adın ya da @herkes yazılınca. Kanal adına sağ tıklayarak da değişir.</small>
          </div>

          <label className="settings-toggle">
            <input
              type="checkbox"
              data-testid="notify-voice-rooms"
              checked={prefs.voice_rooms}
              onChange={(event) => void notifyHub.savePrefs({ voice_rooms: event.target.checked })}
            />
            <span>
              Ses odası açılınca
              <small className="settings-hint">“Ayşe ses odasına girdi”: boş bir odaya ilk giren olunca (oda başına 10 dakikada bir).</small>
            </span>
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              data-testid="notify-calls"
              checked={prefs.calls}
              onChange={(event) => void notifyHub.savePrefs({ calls: event.target.checked })}
            />
            <span>
              Çağrılar
              <small className="settings-hint">Biri seni ses odasına çağırınca.</small>
            </span>
          </label>

          <fieldset className="notify-quiet">
            <legend>Sessiz saatler</legend>
            <label className="settings-toggle">
              <input
                type="checkbox"
                data-testid="notify-quiet"
                checked={prefs.quiet.enabled}
                onChange={(event) => void notifyHub.savePrefs({ quiet: { enabled: event.target.checked } })}
              />
              <span>
                Her gün bu saatlerde bildirim gönderme
                <small className="settings-hint">Seni anan (@ad, @herkes) mesajlar yine gelir.</small>
              </span>
            </label>
            <div className="notify-quiet-times">
              <label>
                Başlangıç
                <input
                  type="time"
                  data-testid="notify-quiet-start"
                  value={start ?? prefs.quiet.start}
                  disabled={!prefs.quiet.enabled}
                  onChange={(event) => setStart(event.target.value)}
                  onBlur={() => {
                    if (start && isHhMm(start) && start !== prefs.quiet.start) void notifyHub.savePrefs({ quiet: { start } })
                    setStart(null)
                  }}
                />
              </label>
              <label>
                Bitiş
                <input
                  type="time"
                  data-testid="notify-quiet-end"
                  value={end ?? prefs.quiet.end}
                  disabled={!prefs.quiet.enabled}
                  onChange={(event) => setEnd(event.target.value)}
                  onBlur={() => {
                    if (end && isHhMm(end) && end !== prefs.quiet.end) void notifyHub.savePrefs({ quiet: { end } })
                    setEnd(null)
                  }}
                />
              </label>
              <label className="notify-tz">
                Saat dilimi
                <select
                  data-testid="notify-quiet-tz"
                  value={prefs.quiet.tz}
                  disabled={!prefs.quiet.enabled}
                  onChange={(event) => void notifyHub.savePrefs({ quiet: { tz: event.target.value } })}
                >
                  {zoneList.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {prefs.quiet.enabled && inQuietHours(prefs.quiet, Date.now()) && (
              <p className="settings-hint" data-testid="notify-quiet-now">Şu an sessiz saatlerdesin.</p>
            )}
            <label className="settings-toggle">
              <input
                type="checkbox"
                data-testid="notify-calls-break-quiet"
                checked={prefs.calls_break_quiet}
                disabled={!prefs.calls}
                onChange={(event) => void notifyHub.savePrefs({ calls_break_quiet: event.target.checked })}
              />
              <span>Çağrılar sessiz saatleri delebilir</span>
            </label>
          </fieldset>
        </>
      )}
    </section>
  )
}
