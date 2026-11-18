import { chromium } from '@playwright/test'
import http from 'node:http'
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<title>r</title>')}).listen(0)
await new Promise(r=>srv.on('listening',r))
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] })
const p = await b.newPage()
await p.goto('http://localhost:'+srv.address().port+'/')
for (const n of [1, 2, 2, 3, 3]) {
 const r = await p.evaluate(async (n) => {
  const s = await navigator.mediaDevices.getUserMedia({audio:true})
  const offers = []
  for (let i = 0; i < n; i++) {
    const a = new RTCPeerConnection(); a.addTrack(s.getAudioTracks()[0], s); await a.setLocalDescription(); offers.push(a.localDescription.toJSON())
  }
  const zs = []
  for (let i = 0; i < n; i++) {
    const z = new RTCPeerConnection(); const log = []
    z.onicecandidate = e => log.push(e.candidate ? 'c' : 'null')
    z.onnegotiationneeded = async () => { await z.setLocalDescription(); log.push('offer') }
    z.addTrack(s.getAudioTracks()[0], s)
    zs.push({ z, log })
  }
  await new Promise(r => setTimeout(r, 2))
  await Promise.all(zs.map(async ({ z, log }, i) => { await z.setRemoteDescription(offers[i]); await z.setLocalDescription(); log.push('ans') }))
  await new Promise(r=>setTimeout(r,2000))
  return zs.map(({ z, log }) => z.iceGatheringState + ':' + log.join(','))
 }, n)
 console.log(n, JSON.stringify(r))
}
await b.close(); srv.close()
