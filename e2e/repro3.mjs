import { chromium } from '@playwright/test'
import http from 'node:http'
const srv = http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<title>r</title>')}).listen(0)
await new Promise(r=>srv.on('listening',r))
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] })
const p = await b.newPage()
await p.goto('http://localhost:'+srv.address().port+'/')
let stuck = 0
for (let k = 0; k < 10; k++) {
 const r = await p.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({audio:true})
  const a = new RTCPeerConnection(); a.addTrack(s.getAudioTracks()[0], s)
  const aC = []; a.onicecandidate = e => aC.push(e.candidate)
  await a.setLocalDescription(); await new Promise(r => setTimeout(r, 200))
  const z = new RTCPeerConnection(); const log = []
  z.onicecandidate = e => log.push(e.candidate ? 'c' : 'null')
  z.addTrack(s.getAudioTracks()[0], s)
  await z.setLocalDescription()       // z's own offer: gathering starts
  log.push('offer')
  await z.setRemoteDescription(a.localDescription)  // implicit rollback, right away
  await z.setLocalDescription(); log.push('ans')
  for (const c of aC) await z.addIceCandidate(c ?? undefined)
  await a.setRemoteDescription(z.localDescription)
  await new Promise(r=>setTimeout(r,1500))
  return z.iceGatheringState + ' ' + z.connectionState + ' ' + log.join(',')
 })
 if (!r.startsWith('complete')) stuck++
 console.log(r)
}
console.log('stuck', stuck)
await b.close(); srv.close()
