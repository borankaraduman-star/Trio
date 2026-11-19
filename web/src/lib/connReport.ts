/**
 * CONTRACT-V4 A3: what Ayarlar › Bağlantı testi measures, and the plain-text
 * report "Raporu kopyala" puts on the clipboard. The report may be pasted
 * anywhere, so it is built from a fixed set of facts and then scrubbed: no
 * token, no IP address (v4, v6, mDNS host names), no long opaque strings, and
 * no names beyond the display names of the people in the call.
 */

export type TurnState = 'checking' | 'working' | 'unreachable' | 'unconfigured'

export const TURN_TEXT: Record<TurnState, string> = {
  checking: 'TURN deneniyor…',
  working: 'TURN çalışıyor',
  unreachable: 'TURN yok veya ulaşılamıyor',
  unconfigured: 'TURN yapılandırılmamış',
}

/** The quiet hint in the voice panel (A3) when /api/ice lists no TURN server. */
export const TURN_HINT = 'TURN ayarlı değil: bazı ağlarda ses bağlanmayabilir'

export interface PeerStat {
  userId: number
  /** From the selected candidate pair: `relay` on either end is "aktarma". */
  path: 'direct' | 'relay' | null
  /** Seconds, as getStats gives it. */
  rtt: number | null
  packetsLost: number | null
  packetsReceived: number | null
}

export function pathText(path: PeerStat['path']): string {
  return path === 'relay' ? 'aktarma (TURN)' : path === 'direct' ? 'doğrudan' : 'bilinmiyor'
}

export function rttText(rtt: number | null): string {
  return rtt === null || !Number.isFinite(rtt) ? '—' : `${Math.round(rtt * 1000)} ms`
}

/** Inbound loss as a percentage of what should have arrived. */
export function lossText(lost: number | null, received: number | null): string {
  if (lost === null || received === null || lost + received <= 0) return '—'
  const percent = (Math.max(0, lost) / (Math.max(0, lost) + received)) * 100
  return `%${percent.toFixed(1).replace('.', ',')}`
}

export interface ReportFacts {
  at: Date
  version: string
  browser: string
  micLevel: number | null
  turn: TurnState
  inVoice: boolean
  peers: readonly (PeerStat & { name: string })[]
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// Two or more colon-separated hex groups with a "::", or three colons or more.
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi
const MDNS = /\b[\w-]+\.local\b/gi
const OPAQUE = /[A-Za-z0-9_\-+/=]{24,}/g
const TOKEN_PARAM = /\b(token|password|credential|username)=\S*/gi

function looksLikeIpv6(candidate: string): boolean {
  return candidate.includes('::') || (candidate.match(/:/g)?.length ?? 0) >= 3
}

/** Remove anything address- or secret-shaped from free text. */
export function scrubReport(text: string): string {
  return text
    .replace(TOKEN_PARAM, '$1=[gizli]')
    .replace(MDNS, '[adres]')
    .replace(IPV6, (match) => (looksLikeIpv6(match) ? '[adres]' : match))
    .replace(IPV4, '[adres]')
    .replace(OPAQUE, '[gizli]')
}

/** A short browser name ("Chrome 157") from a user agent, nothing else of it. */
export function browserName(userAgent: string): string {
  const pick = (re: RegExp, name: string) => {
    const match = userAgent.match(re)
    return match ? `${name} ${match[1]}` : null
  }
  return (
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/Electron\/(\d+)/, 'Trio masaüstü (Electron)') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[^ ]* Safari/, 'Safari') ??
    'bilinmiyor'
  )
}

export function micLevelText(level: number | null): string {
  if (level === null) return 'ölçülmedi'
  if (level < 0.01) return 'ses yok'
  return `%${Math.round(Math.min(1, level) * 100)}`
}

export function buildReport(facts: ReportFacts): string {
  const lines = [
    'Trio bağlantı raporu',
    `Zaman: ${facts.at.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    `Sürüm: ${facts.version}`,
    `Tarayıcı: ${facts.browser}`,
    `Mikrofon seviyesi: ${micLevelText(facts.micLevel)}`,
    `TURN: ${TURN_TEXT[facts.turn]}`,
  ]
  if (!facts.inVoice) {
    lines.push('Ses odası: değil')
  } else if (facts.peers.length === 0) {
    lines.push('Ses odası: tek başına')
  } else {
    lines.push('Ses odası:')
    for (const peer of facts.peers) {
      lines.push(
        `- ${peer.name}: ${pathText(peer.path)}, gidiş-dönüş ${rttText(peer.rtt)}, kayıp ${lossText(peer.packetsLost, peer.packetsReceived)}`,
      )
    }
  }
  // The names are display names (≤ 32 characters, no control characters);
  // scrubbing runs over them too, so a name shaped like an address goes.
  return scrubReport(lines.join('\n'))
}

/** TURN state from what a throwaway connection gathered (see probeTurn). */
export function classifyTurn(hasTurnServer: boolean, sawRelayCandidate: boolean, timedOut: boolean): TurnState {
  if (!hasTurnServer) return 'unconfigured'
  if (sawRelayCandidate) return 'working'
  return timedOut ? 'unreachable' : 'checking'
}

export const TURN_PROBE_MS = 5000

/**
 * Builds a throwaway RTCPeerConnection with the ICE list and gathers
 * candidates for one data channel: a `relay` candidate means a TURN server
 * answered. Nothing is connected to anybody; the connection is closed after.
 */
export async function probeTurn(
  servers: RTCIceServer[],
  hasTurnServer: boolean,
  create: (config: RTCConfiguration) => RTCPeerConnection = (config) => new RTCPeerConnection(config),
  timeoutMs = TURN_PROBE_MS,
): Promise<TurnState> {
  if (!hasTurnServer) return 'unconfigured'
  let pc: RTCPeerConnection
  try {
    pc = create({ iceServers: servers, iceTransportPolicy: 'relay' })
  } catch {
    return 'unreachable'
  }
  try {
    return await new Promise<TurnState>((resolve) => {
      const timer = setTimeout(() => resolve(classifyTurn(true, false, true)), timeoutMs)
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && (candidate.type === 'relay' || / typ relay /.test(candidate.candidate))) {
          clearTimeout(timer)
          resolve('working')
        } else if (!candidate) {
          clearTimeout(timer)
          resolve(classifyTurn(true, false, true))
        }
      }
      pc.createDataChannel('trio-turn-probe')
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(timer)
          resolve('unreachable')
        })
    })
  } finally {
    pc.onicecandidate = null
    pc.close()
  }
}
