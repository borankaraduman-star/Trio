import { describe, expect, it } from 'vitest'
import { planResume, resumeDecision } from '../lib/voiceResume'

const ME = 1
const live = (id: number) => ({ id, live: true, stable: true })

describe('planResume (CONTRACT-V4 A1 reconciliation)', () => {
  it('keeps live, stable connections to listed peers', () => {
    const plan = planResume([live(2), live(3)], [2, 3], [], ME)
    expect(plan).toEqual({ keep: [2, 3], restart: [], create: [], wait: [], unlisted: [] })
  })

  it('restarts a listed peer that is not live or was caught mid-negotiation', () => {
    const plan = planResume(
      [
        { id: 2, live: false, stable: true },
        { id: 3, live: true, stable: false },
      ],
      [2, 3],
      [],
      ME,
    )
    expect(plan.restart).toEqual([2, 3])
    expect(plan.keep).toEqual([])
  })

  it('creates connections only to listed peers it has none for', () => {
    const plan = planResume([live(2)], [2, 3], [], ME)
    expect(plan.keep).toEqual([2])
    expect(plan.create).toEqual([3])
  })

  it('never connects to a member in the grace, and keeps one it has unsignalled', () => {
    const plan = planResume([live(2)], [], [2, 3], ME)
    expect(plan.create).toEqual([])
    expect(plan.wait).toEqual([2])
    expect(plan.unlisted).toEqual([]) // the server will say voice.left or voice.joined
  })

  it('waits for an unlisted kept peer (after a server restart everyone resumes in turn)', () => {
    const plan = planResume([live(2), live(3)], [], [], ME)
    expect(plan.wait).toEqual([2, 3])
    expect(plan.unlisted).toEqual([2, 3])
    expect(plan.keep).toEqual([])
  })

  it('ignores itself in every list', () => {
    const plan = planResume([live(2)], [ME, 2], [ME], ME)
    expect(plan).toEqual({ keep: [2], restart: [], create: [], wait: [], unlisted: [] })
  })

  it('a peer listed in both lists is taken as listed', () => {
    const plan = planResume([live(2)], [2], [2], ME)
    expect(plan.keep).toEqual([2])
    expect(plan.wait).toEqual([])
  })
})

describe('resumeDecision', () => {
  it('resumes when the place is in its grace, gone, or held by this call', () => {
    expect(resumeDecision(null, 's1')).toBe('resume')
    expect(resumeDecision({ channelId: 2, reconnecting: true, session: 'other' }, 's1')).toBe('resume')
    expect(resumeDecision({ channelId: 2, reconnecting: false, session: 's1' }, 's1')).toBe('resume')
  })

  it('stops when another tab or device holds the place', () => {
    expect(resumeDecision({ channelId: 2, reconnecting: false, session: 's2' }, 's1')).toBe('elsewhere')
    expect(resumeDecision({ channelId: 2, reconnecting: false, session: null }, 's1')).toBe('elsewhere')
  })
})
