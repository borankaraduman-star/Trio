/** CONTRACT-V6-OPS §7: what the client says about the server's storage, in Turkish. */

export const NOT_PERSISTENT_TEXT = 'Kalıcı disk bağlı değil: bir sonraki güncellemede her şey silinir.'
export const SERVER_RESET_NOTICE = 'Sunucu sıfırlandı, herkes yeniden katılmalı.'

export interface Health {
  persistent: boolean | null
  dataSince: string | null
}

export function parseHealth(body: unknown): Health {
  const value = (body ?? {}) as { persistent?: unknown; data_since?: unknown }
  return {
    persistent: typeof value.persistent === 'boolean' ? value.persistent : null,
    dataSince: typeof value.data_since === 'string' ? value.data_since : null,
  }
}

/**
 * The join screen's sentence after a session ended (401 / 4401). `known` is the
 * server's `data_since` remembered while this device's session was valid;
 * `current` is what the server says now. A different value means the database
 * this session lived in is gone: the server was reset, nobody signed this
 * device out. Unknown either way: the usual sentence.
 */
export function sessionEndedNotice(known: string | null, current: string | null, fallback: string): string {
  return known && current && known !== current ? SERVER_RESET_NOTICE : fallback
}

/** "Veri: 12 gündür, 9. başlatma". */
export function dataAgeLine(dataSince: string | null, bootCount: number | null, nowMs: number): string | null {
  if (!dataSince) return null
  const since = Date.parse(dataSince)
  if (!Number.isFinite(since)) return null
  const minutes = Math.max(0, Math.floor((nowMs - since) / 60000))
  const age =
    minutes < 60
      ? minutes < 2
        ? 'birkaç dakikadır'
        : `${minutes} dakikadır`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)} saattir`
        : `${Math.floor(minutes / (24 * 60))} gündür`
  return bootCount ? `Veri: ${age}, ${bootCount}. başlatma` : `Veri: ${age}`
}

/** "2 boş yer var": free seats a leaked invite code could fill, or null. */
export function freeSeatsLine(maxUsers: number, activeUsers: number): string | null {
  const free = maxUsers - activeUsers
  return free > 0 ? `${free} boş yer var` : null
}
