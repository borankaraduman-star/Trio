/**
 * CONTRACT-V4 A1: what a client that kept its peer connections across a
 * signalling drop does with the `voice.peers {resumed: true}` its resume is
 * answered with. Pure, so every case is a unit test (voiceResume.test.ts);
 * `VoiceEngine.reconcileResume` applies the plan.
 */

export interface KeptPeer {
  id: number
  /** connectionState is `connected` or `connecting` (the contract's "live"). */
  live: boolean
  /** signalingState is `stable` and no offer is being made. */
  stable: boolean
}

export interface ResumePlan {
  /** Listed, live and stable: kept as they are (turn-taking starts over). */
  keep: number[]
  /**
   * Listed but not live, or caught mid-negotiation (an offer or answer was lost
   * with the socket): started again on fresh connections, never rolled back.
   */
  restart: number[]
  /** Listed and not kept: connected to as on any join. */
  create: number[]
  /**
   * Kept, but the server cannot reach them now: in its grace (`reconnecting`)
   * or not listed at all. Kept and NOT signalled until their own
   * `voice.joined {resumed: true}`; an unlisted one is closed if it has not
   * come back within the grace (after a server restart everybody resumes one
   * by one, so "not listed" mostly means "not back yet").
   */
  wait: number[]
  /** Of `wait`, those the server does not list at all (they get a deadline). */
  unlisted: number[]
}

export function planResume(
  kept: readonly KeptPeer[],
  listed: readonly number[],
  reconnecting: readonly number[],
  myId: number,
): ResumePlan {
  const plan: ResumePlan = { keep: [], restart: [], create: [], wait: [], unlisted: [] }
  const listedSet = new Set(listed.filter((id) => id !== myId))
  const graceSet = new Set(reconnecting.filter((id) => id !== myId && !listedSet.has(id)))
  const keptIds = new Set<number>()
  for (const peer of kept) {
    if (peer.id === myId) continue
    keptIds.add(peer.id)
    if (listedSet.has(peer.id)) {
      if (peer.live && peer.stable) plan.keep.push(peer.id)
      else plan.restart.push(peer.id)
    } else {
      plan.wait.push(peer.id)
      if (!graceSet.has(peer.id)) plan.unlisted.push(peer.id)
    }
  }
  for (const id of listedSet) if (!keptIds.has(id)) plan.create.push(id)
  const order = (a: number, b: number) => a - b
  plan.keep.sort(order)
  plan.restart.sort(order)
  plan.create.sort(order)
  plan.wait.sort(order)
  plan.unlisted.sort(order)
  return plan
}

/**
 * What to do with my own entry of `ready.voice` before resuming: `resume`
 * when the place is mine (in its grace, or still bound to a socket the server
 * has not seen die — same session), or not there at all (the grace ran out,
 * the server restarted); `elsewhere` when another tab or device of mine holds
 * it now (listed, not reconnecting, another session).
 */
export function resumeDecision(
  own: { channelId: number; reconnecting: boolean; session: string | null } | null,
  mySession: string,
): 'resume' | 'elsewhere' {
  if (!own || own.reconnecting) return 'resume'
  if (own.session === mySession) return 'resume'
  // No session at all: a membership from a client that predates it, i.e.
  // somebody else's join, never this call's.
  return 'elsewhere'
}
