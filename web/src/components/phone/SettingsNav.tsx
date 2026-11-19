import type { KeyboardEvent } from 'react'

/** CONTRACT-V7-PHONE §5: the settings' sections, in order. Yönetim is the owner's only. */
export type SettingsTab = 'ses' | 'goruntu' | 'bildirimler' | 'hesap' | 'depolama' | 'yonetim' | 'hakkinda'

export interface SettingsTabInfo {
  id: SettingsTab
  title: string
  /** What is inside, under the title in the phone's list. */
  hint: string
}

export const SETTINGS_TABS: readonly SettingsTabInfo[] = [
  { id: 'ses', title: 'Ses', hint: 'Mikrofon, hoparlör, giriş modu, kısayollar, bağlantı testi' },
  { id: 'goruntu', title: 'Görüntü', hint: 'Kamera, ekran paylaşımı' },
  { id: 'bildirimler', title: 'Bildirimler', hint: 'Bu cihaz, kanallar, sessiz saatler' },
  { id: 'hesap', title: 'Hesap', hint: 'Profil, cihaz ekleme, oyun durumu, sunucu, çıkış' },
  { id: 'depolama', title: 'Depolama', hint: 'Dosyaların ve kullanılan alan' },
  { id: 'yonetim', title: 'Yönetim', hint: 'Yedek, kişiler, hatalar' },
  { id: 'hakkinda', title: 'Hakkında', hint: 'Sürümler, uygulamayı indir' },
]

export function settingsTabTitle(tab: SettingsTab): string {
  return SETTINGS_TABS.find((info) => info.id === tab)?.title ?? 'Ayarlar'
}

export function SettingsNav({
  tabs,
  current,
  phone,
  onChoose,
}: {
  tabs: readonly SettingsTabInfo[]
  current: SettingsTab | null
  phone: boolean
  onChoose: (tab: SettingsTab) => void
}) {
  // Arrow keys move between the tabs (and choose them, like a tab list does).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = phone ? ['ArrowDown', 'ArrowUp'] : ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']
    if (!keys.includes(event.key)) return
    const index = tabs.findIndex((tab) => tab.id === current)
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(Math.max(index, 0) + step + tabs.length) % tabs.length]
    if (!next) return
    event.preventDefault()
    onChoose(next.id)
    event.currentTarget.querySelector<HTMLElement>(`#settings-tab-${next.id}`)?.focus()
  }
  return (
    <div
      className={phone ? 'v7-settings-nav list' : 'v7-settings-nav'}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Ayar bölümleri"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          data-testid={`settings-tab-${tab.id}`}
          aria-selected={tab.id === current}
          aria-controls={tab.id === current ? `settings-panel-${tab.id}` : undefined}
          tabIndex={tab.id === current || (current === null && tab === tabs[0]) ? 0 : -1}
          onClick={() => onChoose(tab.id)}
        >
          <span className="v7-settings-nav-title">{tab.title}</span>
          {phone && <small>{tab.hint}</small>}
          {phone && (
            <svg className="v7-settings-nav-chevron" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          )}
        </button>
      ))}
    </div>
  )
}
