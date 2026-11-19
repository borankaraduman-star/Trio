/**
 * CONTRACT-V8-MUSIC §3: stereo Opus for the music m-lines only.
 *
 * Measured in this Chromium (153, e2e's): a stereo track sent with the
 * default SDP arrives DOWNMIXED to mono (left = right = their average), and
 * at 32 kbit/s. What brings stereo through is `stereo=1` in the RECEIVER's
 * own description of that m-line — the receiver's decoder takes its channel
 * count from its local fmtp, and the sender's encoder from the remote one, so
 * the receiver writing it into the description it sends covers both. Munging
 * only the description the sender receives (or the offer the receiver
 * receives) still gave mono. `contentHint = "music"` changed nothing
 * measurable; the bitrate needs the sender's `maxBitrate` (stereo=1 alone
 * gives 64 kbit/s).
 *
 * So every local description (offer or answer) gets `stereo=1;sprop-stereo=1`
 * on the Opus payload of the m-lines that carry music in either direction,
 * and on no other m-line (a microphone stays a mono 32 kbit/s stream).
 */

/** The description with stereo Opus on the m-lines whose `a=mid` is in `mids`. */
export function withStereo(sdp: string, mids: ReadonlySet<string>): string {
  if (mids.size === 0) return sdp
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(eol)
  // Section starts: the session part, then one per m-line.
  const starts: number[] = [0]
  lines.forEach((line, index) => {
    if (index > 0 && line.startsWith('m=')) starts.push(index)
  })
  starts.push(lines.length)
  const out: string[] = []
  for (let s = 0; s + 1 < starts.length; s++) {
    const section = lines.slice(starts[s], starts[s + 1])
    out.push(...(s === 0 ? section : stereoSection(section, mids)))
  }
  return out.join(eol)
}

function stereoSection(section: string[], mids: ReadonlySet<string>): string[] {
  if (!section[0]?.startsWith('m=audio')) return section
  const mid = section.find((line) => line.startsWith('a=mid:'))?.slice('a=mid:'.length).trim()
  if (mid === undefined || !mids.has(mid)) return section
  const opus = new Set<string>()
  for (const line of section) {
    const match = /^a=rtpmap:(\d+) opus\/48000\/2/i.exec(line)
    if (match) opus.add(match[1])
  }
  if (opus.size === 0) return section
  const seen = new Set<string>()
  const result = section.map((line) => {
    const match = /^a=fmtp:(\d+) (.*)$/.exec(line)
    if (!match || !opus.has(match[1])) return line
    seen.add(match[1])
    return `a=fmtp:${match[1]} ${addParams(match[2])}`
  })
  // An Opus payload without an fmtp line gets one, right after its rtpmap.
  for (const pt of opus) {
    if (seen.has(pt)) continue
    const at = result.findIndex((line) => line.startsWith(`a=rtpmap:${pt} `))
    result.splice(at + 1, 0, `a=fmtp:${pt} stereo=1;sprop-stereo=1`)
  }
  return result
}

function addParams(params: string): string {
  const parts = params
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^(stereo|sprop-stereo)=/i.test(part))
  return [...parts, 'stereo=1', 'sprop-stereo=1'].join(';')
}

/** CONTRACT-V8-MUSIC §3: what a music sender sends (Opus is ~transparent for music there). */
export const MUSIC_MAX_BITRATE = 128_000

/** The mids of `sdp`'s audio m-lines whose `a=msid` names `streamId`. */
export function midsForStream(sdp: string | undefined, streamId: string | null | undefined): string[] {
  if (!sdp || !streamId) return []
  const mids: string[] = []
  for (const section of sdp.split(/\r?\nm=/).slice(1)) {
    if (!section.startsWith('audio')) continue
    const mid = /\r?\na=mid:([^\r\n]+)/.exec(section)?.[1]?.trim()
    const msids = [...section.matchAll(/\r?\na=msid:(\S+)/g)].map((match) => match[1])
    if (mid !== undefined && msids.includes(streamId)) mids.push(mid)
  }
  return mids
}
