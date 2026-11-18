import { describe, expect, it } from 'vitest'
import { gateOpen, micConstraints } from '../audio/pipeline'
import { buildTiles, gridColumns } from '../components/CallStage'
import { deviceMissing, deviceOptions, labelsHidden } from '../lib/devices'
import { createInitialState, reducer, type AppState } from '../store'
import type { Message, ServerEvent } from '../types'

describe('audio pipeline rules', () => {
  it('sends only when not muted and the PTT gate is open', () => {
    expect(gateOpen(false, true)).toBe(true)
    expect(gateOpen(true, true)).toBe(false)
    expect(gateOpen(false, false)).toBe(false)
  })

  it('turns the browser suppressor off while RNNoise runs, keeps AEC and AGC', () => {
    const constraints = micConstraints('dev', false).audio as MediaTrackConstraints
    expect(constraints).toMatchObject({
      deviceId: { exact: 'dev' },
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: false,
    })
    expect(micConstraints('', true).audio).not.toHaveProperty('deviceId')
  })
})

describe('devices', () => {
  const devices = [
    { deviceId: 'default', kind: 'audioinput', label: 'Varsayılan - USB' },
    { deviceId: 'a1', kind: 'audioinput', label: 'USB Mikrofon' },
    { deviceId: 'a2', kind: 'audioinput', label: '' },
    { deviceId: 'a1', kind: 'audioinput', label: 'USB Mikrofon' },
    { deviceId: 'v1', kind: 'videoinput', label: '' },
  ]

  it('lists default first, real devices after, names the unnamed', () => {
    expect(deviceOptions(devices, 'audioinput')).toEqual([
      { id: '', label: 'Sistem varsayılanı' },
      { id: 'a1', label: 'USB Mikrofon' },
      { id: 'a2', label: 'Mikrofon 2' },
    ])
    expect(deviceOptions(devices, 'videoinput')).toEqual([
      { id: '', label: 'Sistem varsayılanı' },
      { id: 'v1', label: 'Kamera 1' },
    ])
  })

  it('without permission: no ids, no names; nothing can be called missing', () => {
    const hidden = [
      { deviceId: '', kind: 'audioinput', label: '' },
      { deviceId: '', kind: 'videoinput', label: '' },
    ]
    expect(deviceOptions(hidden, 'audioinput')).toEqual([{ id: '', label: 'Sistem varsayılanı' }])
    expect(labelsHidden(hidden, 'audioinput')).toBe(true)
    expect(labelsHidden(devices, 'audioinput')).toBe(false)
    expect(deviceMissing(hidden, 'audioinput', 'a1')).toBe(false)
  })

  it('a chosen device that disappeared is missing; the default never is', () => {
    expect(deviceMissing(devices, 'audioinput', 'gone')).toBe(true)
    expect(deviceMissing(devices, 'audioinput', 'a1')).toBe(false)
    expect(deviceMissing(devices, 'audioinput', '')).toBe(false)
  })
})

describe('the call stage', () => {
  it('columns for N tiles', () => {
    expect([1, 2, 3, 4, 5, 9, 10].map(gridColumns)).toEqual([1, 2, 2, 2, 3, 3, 4])
  })

  it('labels screens and cameras by meta, people in id order, own tiles last', () => {
    const s = (id: string) => ({ id }) as MediaStream
    const tiles = buildTiles({
      remoteScreens: [{ userId: 3, stream: s('scr3') }],
      remoteCameras: [
        { userId: 3, stream: s('cam3') },
        { userId: 2, stream: s('cam2') },
      ],
      localScreen: null,
      localCamera: s('mine'),
      nameOf: (id) => (id === 2 ? 'Bora' : 'Cem'),
    })
    expect(tiles.map((t) => [t.testId, t.kind, t.label])).toEqual([
      ['remote-camera-2', 'camera', 'Bora'],
      ['remote-video', 'screen', 'Cem · ekran'],
      ['remote-camera-3', 'camera', 'Cem'],
      ['local-camera', 'camera', 'Sen'],
    ])
    expect(tiles[3]).toMatchObject({ mirrored: true, silent: true })
    expect(tiles[1].silent).toBe(false)
  })
})

describe('store: v2 fields', () => {
  const me = { id: 1, name: 'Ada' }
  function ready(): AppState {
    const event: ServerEvent = {
      type: 'ready',
      user: me,
      users: [{ ...me, online: true }],
      channels: [
        { id: 10, name: 'genel', kind: 'text' },
        { id: 20, name: 'Sohbet', kind: 'voice' },
      ],
      voice: { '20': [{ user_id: 2, muted: false, deafened: false, screensharing: false, camera: true }] },
    }
    return reducer(createInitialState({ me }), { type: 'server', event, now: 0, viewing: true })
  }
  const flags = { muted: false, deafened: false, screensharing: false }

  it('keeps the camera flag from ready, voice.joined and voice.state', () => {
    let state = ready()
    expect(state.voice[20][0].camera).toBe(true)
    state = reducer(state, {
      type: 'server',
      event: { type: 'voice.state', channel_id: 20, user_id: 2, ...flags, camera: false },
      now: 0,
      viewing: true,
    })
    expect(state.voice[20][0]).toEqual({ user_id: 2, ...flags, camera: false })
    state = reducer(state, {
      type: 'server',
      event: { type: 'voice.joined', channel_id: 20, user_id: 1, ...flags, camera: true },
      now: 0,
      viewing: true,
    })
    expect(state.voice[20][1]).toEqual({ user_id: 1, ...flags, camera: true })
  })

  it('a v1 frame without camera leaves the field out', () => {
    const state = reducer(ready(), {
      type: 'server',
      event: { type: 'voice.joined', channel_id: 20, user_id: 3, ...flags },
      now: 0,
      viewing: true,
    })
    expect(state.voice[20][1]).not.toHaveProperty('camera')
  })

  it('carries attachments: optimistic row, then the stored message replaces it in order', () => {
    const attachments = [
      { id: 'a', filename: 'a.png', content_type: 'image/png', size: 1, url: '/api/files/a/a.png' },
      { id: 'b', filename: 'b.txt', content_type: 'text/plain', size: 2, url: '/api/files/b/b.txt' },
    ]
    let state = ready()
    state = reducer(state, {
      type: 'message.optimistic',
      message: {
        id: -1,
        channel_id: 10,
        author: me,
        content: '',
        created_at: '2026-11-18T10:00:00Z',
        attachments,
        key: 'n1',
        nonce: 'n1',
        status: 'pending',
      },
    })
    expect(state.messages[10].items[0].attachments).toEqual(attachments)
    const stored: Message = {
      id: 5,
      channel_id: 10,
      author: me,
      content: '',
      created_at: '2026-11-18T10:00:01Z',
      attachments,
    }
    state = reducer(state, { type: 'server', event: { type: 'message.new', message: stored, nonce: 'n1' }, now: 0, viewing: true })
    expect(state.messages[10].items).toHaveLength(1)
    expect(state.messages[10].items[0]).toMatchObject({ id: 5, key: 'n1', status: 'sent' })
    expect(state.messages[10].items[0].attachments?.map((a) => a.id)).toEqual(['a', 'b'])
  })
})
