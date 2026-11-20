// CONTRACT-V12-MINI-DESKTOP smoke run: the built app (dist/) against a local page that opens
// mini windows the way the web client does, and a few it must refuse. Prints what Electron did.
// Not part of npm test (needs a display):
//   npm run build && xvfb-run -a node_modules/electron/dist/electron --no-sandbox scripts/mini-smoke.cjs
// Expect: 'open ok true', every 'bad … false', 'extra 5 false', the child video playing,
// the mini windows 'aot true focused false', and the 3000x2000 request capped at 60 % of the screen.
const { app, BrowserWindow, webContents } = require('electron');
const http = require('http'); const path = require('path'); const os = require('os'); const fs=require('fs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'trio-ud-')));
const page = `<!doctype html><html><head><title>Trio</title></head><body><script>
const log=(...a)=>console.log('[page]',...a);
const d=window.trioDesktop; log('bridge', typeof d, d && d.mini && d.mini.supported, typeof d.setWatchHotkeys, typeof d.onWindowState);
d.mini.onState(s=>log('state', JSON.stringify(s)));
d.onWindowState(s=>log('winstate', JSON.stringify(s)));
setTimeout(()=>{
  const w = window.open('/mini.html?m=screen-u1','trio-mini-screen-u1','popup,width=3000,height=2000,left=0,top=0,transparent=yes,opacity=0.1,frame=yes');
  log('open ok', !!w);
  const bad = [
    ['/mini.html?m=x','other-name'], ['https://example.com/mini.html?m=x','trio-mini-x'], ['/other.html?m=x','trio-mini-x'],
    ['/mini.html?m=y','trio-mini-x'], ['/mini.html?m=a&b=1','trio-mini-a']];
  for (const [u,n] of bad) log('bad', u, n, !!window.open(u,n,'popup'));
  setTimeout(()=>{
    try { const v=w.document.createElement('video'); v.muted=true; v.autoplay=true; w.document.body.appendChild(v); const c=document.createElement('canvas'); c.width=320;c.height=180; const g=c.getContext('2d'); setInterval(()=>{g.fillStyle='#'+Math.floor(Math.random()*4095).toString(16).padStart(3,'0'); g.fillRect(0,0,320,180)},50); v.srcObject=c.captureStream(20); setTimeout(()=>log('child video from opener stream', v.videoWidth+'x'+v.videoHeight, 'readyState', v.readyState, 'paused', v.paused),1000); log('opener reaches child DOM', w.document.title, typeof w.trioDesktop, typeof w.trioMiniWindow); } catch(e) { log('child DOM err', String(e)); }
    for (let i=2;i<=5;i++) log('extra', i, !!window.open('/mini.html?m=k'+i,'trio-mini-k'+i, i===2?'popup,focusable=no':'popup'));
    d.mini.setOptions('screen-u1',{opacity:0.1, clickThrough:true, aspect:4/3});
    d.mini.setOptions('../evil',{opacity:0.5});
    try { w.resizeTo(5000,5000); w.moveTo(-3000,-3000); } catch(e){ log('resize err', String(e)); }
    setTimeout(()=>{ d.mini.close('screen-u1'); setTimeout(()=>log('DONE'),800); }, 2500);
  }, 1500);
}, 1000);
</script></body></html>`;
const mini = `<!doctype html><html><head><title>mini</title></head><body style="-webkit-app-region:drag;background:#222;color:#fff">mini<script>console.log('[mini] trioDesktop', typeof window.trioDesktop, 'trioMiniWindow', JSON.stringify(window.trioMiniWindow)); try{ console.log('[mini] nested open', !!window.open('/mini.html?m=z','trio-mini-z')) }catch(e){}</script></body></html>`;
const srv = http.createServer((q,r)=>{const p=new URL(q.url,'http://x').pathname; const b=p==='/'?page:p==='/mini.html'?mini:null; r.writeHead(b?200:404,{'content-type':'text/html'}); r.end(b||'no')});
srv.listen(0,'127.0.0.1',()=>{
  process.env.TRIO_SERVER_URL=`http://127.0.0.1:${srv.address().port}`;
  app.on('web-contents-created',(_e,wc)=>{ for (const ev of ['will-navigate','will-redirect','did-fail-load','did-start-navigation','did-finish-load']) wc.on(ev,(e,...a)=>console.log('[ev]',ev,(e&&e.url)||a.slice(0,3).join(' '))); }); app.on('web-contents-created',(_e,wc)=>wc.on('console-message',(e)=>{ const m=e.message; console.log(m); if(m.includes('DONE')) setTimeout(()=>{ report(); app.exit(0)},300);}));
  app.on('browser-window-created',(_e,w)=>{ setTimeout(()=>{ if(w.isDestroyed())return; console.log('[win]', w.webContents.getURL(), JSON.stringify(w.getBounds()), 'aot', w.isAlwaysOnTop(), 'focused', w.isFocused(), 'visible', w.isVisible(), 'opacity', w.getOpacity(), 'resizable', w.isResizable(), 'fullscreenable', w.isFullScreenable(), 'focusable', w.isFocusable()); w.on('closed',()=>console.log('[win] closed')); }, 1200); });
  const report=()=>{ for (const w of BrowserWindow.getAllWindows()) console.log('[final]', w.webContents.getURL(), JSON.stringify(w.getBounds()), 'opacity', w.getOpacity(), 'aot', w.isAlwaysOnTop()); };
  require(require('path').join(__dirname, '..', 'dist', 'main', 'main.js'));
  setTimeout(()=>{report(); app.exit(1)}, 15000);
});
