import { freshServer } from '../lib/server'
import { expectConnected, joinVoice, test, threePeople } from '../lib/trio'
test.beforeEach(async () => { await freshServer() })
test('debug', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio)
  const t0 = Date.now()
  for (const p of people) {
    await p.context.addInitScript((name) => {
      const Native = WebSocket
      const t = () => (performance.timeOrigin + performance.now()) % 100000 | 0
      const fmt = (f: any) => `${f.type} ${f.to ?? f.from ?? ''} ${f.data ? Object.keys(f.data)[0] + ':' + (f.data.description?.type ?? (f.data.candidate === null ? 'null' : f.data.candidate?.candidate?.split(' ')[4] ?? '')) : ''}${f.peers ? JSON.stringify(f.peers) : ''}${f.user_id ? ' u' + f.user_id : ''}`
      ;(window as any).WebSocket = class extends Native {
        constructor(u: any) { super(u); this.addEventListener('message', (e) => { const f = JSON.parse(String(e.data)); if (f.type !== 'pong' && f.type !== 'ready') console.log(`${t()} [${name}] IN  ${fmt(f)}`) }) }
        send(d: any) { const f = JSON.parse(String(d)); if (f.type !== 'ping') console.log(`${t()} [${name}] OUT ${fmt(f)}`); return super.send(d) }
      }
      const NPC = window.RTCPeerConnection
      ;(window as any).RTCPeerConnection = class extends NPC { constructor(...a: any[]) { super(...a); this.addEventListener('icegatheringstatechange', () => console.log(`${t()} [${name}] gather ${this.iceGatheringState}`)); this.addEventListener('signalingstatechange', () => console.log(`${t()} [${name}] sig ${this.signalingState}`)) } }
    }, p.name)
    p.page.on('console', (m) => console.log(m.text()))
    await p.page.reload(); await expectConnected(p.page)
  }
  for (const p of people) { await joinVoice(p) }
  await people[0].page.waitForTimeout(4000)
  for (const p of people) {
    const r = await p.page.evaluate(() => (window as any).__trioPcs.map((pc: RTCPeerConnection) => [pc.connectionState, pc.iceGatheringState, pc.signalingState]))
    console.log(p.name, JSON.stringify(r))
  }
  for (const p of people) await p.page.evaluate(() => (window as any).__trioPcs.forEach((pc: RTCPeerConnection) => { if (pc.connectionState === 'new') { console.log('RESTART'); pc.restartIce() } }))
  await people[0].page.waitForTimeout(3000)
  for (const p of people) {
    const r = await p.page.evaluate(() => (window as any).__trioPcs.map((pc: RTCPeerConnection) => [pc.connectionState, pc.iceGatheringState, pc.signalingState]))
    console.log('AFTER', p.name, JSON.stringify(r))
  }
  void t0
})
