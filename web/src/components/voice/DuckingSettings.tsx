import { useSyncExternalStore } from 'react'
import { duckPrefsStore } from '../../audio/ducking'

/**
 * Ayarlar › Ses: "Biri konuşunca yayın sesini kıs" (CONTRACT-V12-DUCKING §3).
 * Only this device, only what I hear.
 */
export function DuckingSection() {
  const prefs = useSyncExternalStore(duckPrefsStore.subscribe, duckPrefsStore.getSnapshot)
  const percent = Math.round(prefs.amount * 100)
  return (
    <section className="settings-section" aria-labelledby="settings-ducking">
      <h3 id="settings-ducking">Yayın sesi</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-duck"
          checked={prefs.enabled}
          onChange={(event) => duckPrefsStore.set({ enabled: event.target.checked })}
        />
        <span>
          Biri konuşunca yayın sesini kıs
          <small className="settings-hint">
            Paylaşılan ekranın sesi, biri konuşurken kısılır ve konuşma bitince geri gelir. Yalnız senin duyduğunu
            değiştirir.
          </small>
        </span>
      </label>
      <label className="settings-range">
        <span>Ne kadar</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          data-testid="settings-duck-amount"
          disabled={!prefs.enabled}
          value={percent}
          onChange={(event) => duckPrefsStore.set({ amount: Number(event.target.value) / 100 })}
        />
        <span className="conn-value" data-testid="settings-duck-amount-value">
          %{percent}
        </span>
      </label>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-duck-music"
          disabled={!prefs.enabled}
          checked={prefs.music}
          onChange={(event) => duckPrefsStore.set({ music: event.target.checked })}
        />
        <span>Paylaşılan müziği de kıs</span>
      </label>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-duck-self"
          disabled={!prefs.enabled}
          checked={prefs.self}
          onChange={(event) => duckPrefsStore.set({ self: event.target.checked })}
        />
        <span>Ben konuşurken de kıs</span>
      </label>
    </section>
  )
}
