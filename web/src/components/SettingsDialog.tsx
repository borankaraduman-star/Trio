import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { deviceOptions, labelsHidden, sinkIdSupported, type DeviceKind } from '../lib/devices'
import { isBindableKey, keyLabel, MOUSE_PTT_KEYS, type Settings } from '../settings'
import { mouseButtonCode } from '../ptt'
import { useDevices } from '../useDevices'
import type { NoiseState } from '../audio/pipeline'
import { SCREEN_AUDIO_WARNING } from '../audio/screenAudio'
import { ConnectionTest, SoundsSection, type ConnectionTestProps } from './ConnectionTest'
import { CloseIcon } from './icons2'
import { AccountSection, type AccountProps } from './AccountSection'
import { ServerSection, type ServerSettingsProps } from './ServerSection'
import { VersionFooter } from './VersionFooter'
import { DownloadLink } from './DownloadLink'
import { StatusSettings } from './GameActivity'
import { ShowChannelSetting } from './ChannelViewers'
import { NotificationsSection } from './notify/NotificationsSection'
import { InputSensitivitySection, ShortcutsSection } from './voice/VoiceEveningSettings'
import { WatchSettingsSection, WatchShortcutsSection } from './watch/WatchSettings'
import { DesktopVersionFooter } from './voice/DesktopVersion'
import { StorageSection } from './owner/StorageSection'
import { OwnerSection } from './owner/OwnerSection'
import { opsStore } from '../owner/opsStore'
import { PHONE_QUERY, screenShareSupported, useMediaQuery } from '../lib/phone'
import { SETTINGS_TABS, SettingsNav, settingsTabTitle, type SettingsTab } from './phone/SettingsNav'

const NOISE_TEXT: Record<NoiseState, string> = {
  active: 'Gürültü engelleme çalışıyor.',
  off: 'Gürültü engelleme kapalı (tarayıcının kendi filtresi açık).',
  unavailable: 'Gürültü engelleme yüklenemedi; ham mikrofon kullanılıyor.',
}

function DeviceSelect({
  id,
  label,
  kind,
  value,
  devices,
  onChange,
  testId,
}: {
  id: string
  label: string
  kind: DeviceKind
  value: string
  devices: ReturnType<typeof useDevices>['devices']
  onChange: (deviceId: string, label: string) => void
  testId: string
}) {
  const options = deviceOptions(devices, kind)
  // A stored device not in the list (unplugged, or names hidden): still shown, so the select is honest.
  const known = options.some((option) => option.id === value)
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} data-testid={testId} value={known ? value : ''} onChange={(event) => {
          const id = event.target.value
          // The browser's own name, not a "Mikrofon 2" placeholder: it is what finds the device again.
          const device = devices.find((d) => d.kind === kind && d.deviceId === id)
          onChange(id, device?.label.trim() ?? '')
        }}>
        {options.map((option) => (
          <option key={option.id || 'default'} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** Press-to-bind: the next key (or, in the desktop app, an extra mouse button) becomes the PTT key. */
function KeyBinder({
  value,
  allowMouse,
  onBind,
}: {
  value: string
  allowMouse: boolean
  onBind: (code: string) => void
}) {
  const [listening, setListening] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!listening) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.code === 'Escape') {
        setListening(false)
        return
      }
      if (!isBindableKey(event.code)) return
      onBind(event.code)
      setListening(false)
    }
    const onMouse = (event: MouseEvent) => {
      const code = mouseButtonCode(event.button)
      if (!allowMouse || !code) return
      event.preventDefault()
      event.stopPropagation()
      onBind(code)
      setListening(false)
    }
    const onBlur = () => setListening(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouse, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [listening, allowMouse, onBind])

  return (
    <div className="settings-field">
      <span className="settings-label" id="settings-ptt-key-label">
        Bas-konuş tuşu
      </span>
      <div className="key-binder">
        <kbd data-testid="settings-ptt-key" aria-labelledby="settings-ptt-key-label">
          {keyLabel(value)}
        </kbd>
        <button
          ref={button}
          type="button"
          className={listening ? 'primary' : 'ghost'}
          data-testid="settings-ptt-bind"
          aria-live="polite"
          onClick={() => setListening((on) => !on)}
        >
          {listening ? 'Bir tuşa bas… (Esc: vazgeç)' : 'Değiştir'}
        </button>
      </div>
      <p className="settings-hint">
        {allowMouse
          ? `Masaüstü uygulamasında tuş, pencere arkadayken de çalışır. Fare tuşları da atanabilir (${MOUSE_PTT_KEYS.map(keyLabel).join(', ')}).`
          : 'Tarayıcıda tuş yalnızca bu sekme öndeyken çalışır; yazı yazarken tetiklenmez.'}
      </p>
    </div>
  )
}

export function SettingsDialog({
  settings,
  onChange,
  onClose,
  inVoice,
  noiseState,
  transmitting,
  isDesktop,
  account,
  onSignOut,
  connectionTest,
  serverSettings,
  serverVersion,
}: {
  settings: Settings
  onChange: (patch: Partial<Omit<Settings, 'version'>>) => void
  onClose: () => void
  inVoice: boolean
  noiseState: NoiseState
  transmitting: boolean
  isDesktop: boolean
  /** v3: the "Hesap" section (add a device, sign out). */
  account?: AccountProps
  onSignOut?: () => void
  /** V4 A3: Bağlantı testi. */
  connectionTest?: ConnectionTestProps
  /** v4: the "Sunucu" section (name and icon). */
  serverSettings?: ServerSettingsProps
  /** v4: `ready.server_version` for the footer; undefined = no footer. */
  serverVersion?: string | null
}) {
  const { devices, requestLabels } = useDevices()
  const dialog = useRef<HTMLDivElement>(null)
  const hidden = labelsHidden(devices, 'audioinput') || labelsHidden(devices, 'videoinput')
  const outputSupported = sinkIdSupported()
  // V7 (CONTRACT-V7-PHONE §5): tabs. A list on the left on a wide screen; on a
  // phone the list first, then one section with a way back.
  const phone = useMediaQuery(PHONE_QUERY)
  const { isOwner } = useSyncExternalStore(opsStore.subscribe, opsStore.getSnapshot)
  useEffect(() => {
    void opsStore.refresh()
  }, [])
  // Opened to make a device code (from the sign-out dialog): straight to Hesap.
  const [chosen, setChosen] = useState<SettingsTab | null>(account?.createAtOnce ? 'hesap' : null)
  const tabs = SETTINGS_TABS.filter((tab) => tab.id !== 'yonetim' || isOwner)
  const valid = chosen !== null && tabs.some((tab) => tab.id === chosen) ? chosen : null
  /** The section shown: none (the list) only on a phone. */
  const tab: SettingsTab | null = valid ?? (phone ? null : 'ses')
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [role="tab"], select, input, button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])

  const choose = (next: SettingsTab | null) => {
    setChosen(next)
    if (dialog.current) dialog.current.scrollTop = 0
    if (panel.current) panel.current.scrollTop = 0
  }

  const devicesSection = (kinds: 'audio' | 'video') => (
    <section className="settings-section" aria-labelledby={`settings-devices-${kinds}`}>
      <h3 id={`settings-devices-${kinds}`}>{kinds === 'audio' ? 'Cihazlar' : 'Kamera'}</h3>
      {hidden && (
        <p className="settings-hint">
          Tarayıcı izin verilene kadar cihaz adlarını göstermiyor.{' '}
          <button type="button" className="link" data-testid="settings-grant" onClick={() => void requestLabels()}>
            Adları göster
          </button>
        </p>
      )}
      {kinds === 'audio' && (
        <>
          <DeviceSelect
            id="settings-mic"
            testId="settings-mic"
            label="Mikrofon"
            kind="audioinput"
            value={settings.micDeviceId}
            devices={devices}
            onChange={(micDeviceId, micDeviceLabel) => onChange({ micDeviceId, micDeviceLabel })}
          />
          {outputSupported ? (
            <DeviceSelect
              id="settings-output"
              testId="settings-output"
              label="Hoparlör / kulaklık"
              kind="audiooutput"
              value={settings.outputDeviceId}
              devices={devices}
              onChange={(outputDeviceId, outputDeviceLabel) => onChange({ outputDeviceId, outputDeviceLabel })}
            />
          ) : (
            <p className="settings-hint">Bu tarayıcı ses çıkış cihazı seçmeyi desteklemiyor.</p>
          )}
        </>
      )}
      {kinds === 'video' && (
        <DeviceSelect
          id="settings-camera"
          testId="settings-camera"
          label="Kamera"
          kind="videoinput"
          value={settings.cameraDeviceId}
          devices={devices}
          onChange={(cameraDeviceId, cameraDeviceLabel) => onChange({ cameraDeviceId, cameraDeviceLabel })}
        />
      )}
    </section>
  )

  const panels: Record<SettingsTab, () => ReactNode> = {
    ses: () => (
      <>
        {devicesSection('audio')}
        <section className="settings-section" aria-labelledby="settings-voice">
          <h3 id="settings-voice">Konuşma</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              data-testid="settings-noise"
              checked={settings.noiseSuppression}
              onChange={(event) => onChange({ noiseSuppression: event.target.checked })}
            />
            <span>
              Gürültü engelleme (RNNoise)
              {inVoice && (
                <small className="settings-hint" data-testid="settings-noise-state" data-state={noiseState}>
                  {NOISE_TEXT[noiseState]}
                </small>
              )}
            </span>
          </label>

          <fieldset className="settings-mode">
            <legend>Giriş modu</legend>
            <label>
              <input
                type="radio"
                name="input-mode"
                data-testid="settings-mode-activity"
                checked={settings.inputMode === 'activity'}
                onChange={() => onChange({ inputMode: 'activity' })}
              />
              Ses etkinliği (mikrofon hep açık)
            </label>
            <label>
              <input
                type="radio"
                name="input-mode"
                data-testid="settings-mode-ptt"
                checked={settings.inputMode === 'ptt'}
                onChange={() => onChange({ inputMode: 'ptt' })}
              />
              Bas-konuş
            </label>
          </fieldset>

          {settings.inputMode === 'ptt' && (
            <KeyBinder value={settings.pttKey} allowMouse={isDesktop} onBind={(pttKey) => onChange({ pttKey })} />
          )}
          {inVoice && (
            <p className="settings-live" data-testid="settings-transmitting" data-on={transmitting}>
              <span className={transmitting ? 'dot online' : 'dot'} /> {transmitting ? 'Sesin gönderiliyor' : 'Sesin gönderilmiyor'}
            </p>
          )}
        </section>
        <InputSensitivitySection />
        <ShortcutsSection />
        <WatchShortcutsSection />
        <SoundsSection
          cuesEnabled={settings.cuesEnabled}
          cueVolume={settings.cueVolume}
          doNotDisturb={settings.doNotDisturb}
          onChange={onChange}
        />
        {connectionTest && (
          <ConnectionTest {...connectionTest} micDeviceId={settings.micDeviceId} outputDeviceId={settings.outputDeviceId} />
        )}
      </>
    ),
    goruntu: () => (
      <>
        {devicesSection('video')}
        <section className="settings-section" aria-labelledby="settings-screen">
          <h3 id="settings-screen">Ekran paylaşımı</h3>
          {screenShareSupported() ? (
            <label className="settings-toggle">
              <input
                type="checkbox"
                data-testid="settings-screen-audio"
                checked={settings.shareScreenAudio}
                onChange={(event) => onChange({ shareScreenAudio: event.target.checked })}
              />
              <span>
                Ekran sesini de paylaş
                <small className="settings-hint">{SCREEN_AUDIO_WARNING}</small>
              </span>
            </label>
          ) : (
            <p className="settings-hint" data-testid="settings-screen-unsupported">
              Bu cihazda ekran paylaşılamıyor; başkalarının paylaştığı ekranları izleyebilirsin.
            </p>
          )}
        </section>
        <WatchSettingsSection />
      </>
    ),
    bildirimler: () => <NotificationsSection />,
    hesap: () => (
      <>
        {account && <AccountSection account={account} onSignOut={onSignOut ?? (() => undefined)} />}
        <StatusSettings />
        <ShowChannelSetting />
        {serverSettings && <ServerSection settings={serverSettings} />}
      </>
    ),
    depolama: () => <StorageSection />,
    yonetim: () => (isOwner ? <OwnerSection /> : null),
    hakkinda: () => (
      <>
        <DownloadLink />
        {serverVersion !== undefined && <VersionFooter serverVersion={serverVersion} />}
        {serverVersion !== undefined && <DesktopVersionFooter serverVersion={serverVersion} />}
      </>
    ),
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className={`modal settings-dialog v7-settings${phone ? ' phone' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-dialog"
        data-tab={tab ?? ''}
      >
        <header className="modal-header">
          {phone && tab !== null && (
            <button
              type="button"
              className="icon-button v7-settings-back"
              data-testid="settings-back"
              aria-label="Ayarlara dön"
              title="Ayarlara dön"
              onClick={() => choose(null)}
            >
              <BackIcon />
            </button>
          )}
          <h2 id="settings-title">{phone && tab !== null ? settingsTabTitle(tab) : 'Ayarlar'}</h2>
          <button
            type="button"
            className="icon-button"
            data-testid="settings-close"
            aria-label="Kapat"
            title="Kapat (Esc)"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="v7-settings-body">
          {(!phone || tab === null) && <SettingsNav tabs={tabs} current={tab} phone={phone} onChoose={choose} />}
          {tab !== null && (
            <div
              ref={panel}
              className="v7-settings-panel"
              role="tabpanel"
              id={`settings-panel-${tab}`}
              aria-labelledby={`settings-tab-${tab}`}
              data-testid={`settings-panel-${tab}`}
            >
              {!phone && <h2 className="v7-settings-panel-title">{settingsTabTitle(tab)}</h2>}
              {panels[tab]()}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BackIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}
