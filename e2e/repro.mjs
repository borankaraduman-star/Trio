import { chromium } from '@playwright/test'
import http from 'node:http'
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<title>r</title>')}).listen(0)
await new Promise(r=>srv.on('listening',r))
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] })
const p = await b.newPage()
await p.goto('http://localhost:'+srv.address().port+'/')
for (const mode of ['E','H','H2','H','H2']) {
 const r = await p.evaluate(async (mode) => {
  const s = await navigator.mediaDevices.getUserMedia({audio:true})
  const a = new RTCPeerConnection()
  a.addTrack(s.getAudioTracks()[0], s)
  const aCands = []
  a.onicecandidate = e => aCands.push(e.candidate)
  await a.setLocalDescription()
  await new Promise(r => setTimeout(r, 300))
  const aOffer = a.localDescription.toJSON()
  const z = new RTCPeerConnection()
  const zc = []
  z.onicecandidate = e => zc.push(e.candidate ? 'c' : 'null')
  z.onnegotiationneeded = async () => { await z.setLocalDescription(); zc.push('sent-' + z.localDescription.type) }
  z.addTrack(s.getAudioTracks()[0].clone(), s)
  if (mode !== 'A' && mode !== 'C') await new Promise(r => setTimeout(r, 0))
  if (mode.startsWith('H')) await new Promise(r => { const t = () => z.iceGatheringState === 'gathering' ? r() : setTimeout(t, 1); t() })
  // remote offer arrives (polite z, no collision seen yet)
  const p1 = (async () => { if (mode === 'H2' && z.signalingState !== 'stable') { await z.setLocalDescription({type:'rollback'}) } await z.setRemoteDescription(aOffer); await z.setLocalDescription(); zc.push('ans') })()
  if (mode !== 'D') await p1
  if (mode !== 'A' && mode !== 'B') for (const c of aCands) z.addIceCandidate(c ?? undefined).catch(e => zc.push('candErr'))
  await p1
  await new Promise(r=>setTimeout(r,3000))
  return { mode, zc: zc.join(','), zGather: z.iceGatheringState, sig: z.signalingState }
 }, mode)
 console.log(JSON.stringify(r))
}
await b.close(); srv.close()
