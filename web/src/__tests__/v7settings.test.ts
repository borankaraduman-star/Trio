import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS, settingsTabTitle } from '../components/phone/SettingsNav'

describe('V7 settings tabs', () => {
  it('has the seven sections in order, Yönetim among them', () => {
    expect(SETTINGS_TABS.map((tab) => tab.title)).toEqual(['Ses', 'Görüntü', 'Bildirimler', 'Hesap', 'Depolama', 'Yönetim', 'Hakkında'])
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(7)
    expect(settingsTabTitle('goruntu')).toBe('Görüntü')
  })
})
