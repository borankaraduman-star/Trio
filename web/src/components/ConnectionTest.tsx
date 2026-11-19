import { useCallback, useEffect, useRef, useState } from 'react'
import { currentEntryScript } from '../lib/buildCheck'
import {
  browserName,
  buildReport,
  lossText,
  micLevelText,
  pathText,
  probeTurn,
  rttText,
  TURN_TEXT,
  type PeerStat,
  type TurnState,
} from '../lib/connReport'
import { hasTurnServer } from '../voice'

/**
 * CONTRACT-V4 A3: Ayarlar › Bağlantı testi. All client side: a microphone
 * level meter with a "kendini duy" loopback, the TURN probe (a throwaway
 * RTCPeerConnection built from /api/ice), the connection to each person while
 * in voice, and "Raporu kopyala".
 */

export interface ConnectionTestProps {
  fetchIce: () => Promise<RTCIceServer[]>
  peerStats: () => Promise<PeerStat[]>
  inVoice: boolean
  nameOf: (userId: number) => string
  /** Told true while the test is on screen (it measures then), false after: the reload guard waits. */
  onActiveChange?: (active: boolean) => void
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

const PEER_POLL_MS = 2000

function clientVersion(): string {
  const script = currentEntryScript()
  const hash = script?.match(/-([A-Za-z0-9_]{6,16})\.js$/)?.[1]
  return hash ? `istemci ${hash}` : 'istemci (geliştirme)'
}

export function ConnectionTest({
  fetchIce,
  peerStats,
  inVoice,
  nameOf,
  micDeviceId,
  outputDeviceId,
  onActiveChange,
}: ConnectionTestProps & { micDeviceId: string; outputDeviceId: string }) {
  const [turn, setTurn] = useState<TurnState>('checking')
  const [peers, setPeers] = useState<PeerStat[]>([])
  const [level, setLevel] = useState<number | null>(null)
  const [peak, setPeak] = useState<number | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [loopback, setLoopback] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const context = useRef<AudioContext | null>(null)
  const loopAudio = useRef<SinkAudio | null>(null)
  // The callers pass fresh arrow functions on every render (the session
  // re-renders on every presence, speaking or stats change). Effects keyed on
  // them re-ran each time: the TURN probe went back to "deneniyor…" and
  // started over, so in a busy call it could show a stale state or never
  // settle, and "Raporu kopyala" copied "TURN deneniyor…". The latest
  // functions are read through a ref instead; the effects run once.
  const latest = useRef({ fetchIce, peerStats, onActiveChange })
  latest.current = { fetchIce, peerStats, onActiveChange }

  useEffect(() => {
    latest.current.onActiveChange?.(true)
    return () => latest.current.onActiveChange?.(false)
  }, [])

  // --- TURN -------------------------------------------------------------------
  const runProbe = useCallback(async () => {
    setTurn('checking')
    let servers: RTCIceServer[] = []
    try {
      servers = await latest.current.fetchIce()
    } catch {
      servers = []
    }
    setTurn(await probeTurn(servers, hasTurnServer(servers)))
  }, [])
  useEffect(() => {
    void runProbe()
  }, [runProbe])

  // --- peers while in voice ---------------------------------------------------
  useEffect(() => {
    if (!inVoice) {
      setPeers([])
      return
    }
    let alive = true
    const poll = () =>
      void latest.current.peerStats().then((stats) => {
        if (alive) setPeers(stats)
      })
    poll()
    const timer = setInterval(poll, PEER_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [inVoice])

  // --- microphone -------------------------------------------------------------
  const stopMic = useCallback(() => {
    for (const track of stream.current?.getTracks() ?? []) track.stop()
    stream.current = null
    void context.current?.close().catch(() => undefined)
    context.current = null
    if (loopAudio.current) loopAudio.current.srcObject = null
    setListening(false)
    setLoopback(false)
    setLevel(null)
  }, [])
  useEffect(() => stopMic, [stopMic])

  const startMic = useCallback(async () => {
    setMicError(null)
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true,
      })
      stream.current = mic
      const audio = new AudioContext()
      context.current = audio
      void audio.resume().catch(() => undefined)
      const analyser = audio.createAnalyser()
      analyser.fftSize = 1024
      audio.createMediaStreamSource(mic).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      setListening(true)
      const tick = () => {
        if (context.current !== audio) return
        analyser.getFloatTimeDomainData(data)
        let max = 0
        for (const sample of data) max = Math.max(max, Math.abs(sample))
        setLevel(max)
        setPeak((previous) => Math.max(previous ?? 0, max))
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } catch {
      setMicError('Mikrofon açılamadı.')
    }
  }, [micDeviceId])

  useEffect(() => {
    const element = loopAudio.current
    if (!element) return
    element.srcObject = loopback ? stream.current : null
    if (loopback) {
      if (typeof element.setSinkId === 'function') void element.setSinkId(outputDeviceId).catch(() => undefined)
      void element.play().catch(() => undefined)
    }
  }, [loopback, outputDeviceId])

  // --- the report ---------------------------------------------------------------
  const copyReport = useCallback(async () => {
    const stats = inVoice ? await peerStats() : []
    const text = buildReport({
      at: new Date(),
      version: clientVersion(),
      browser: browserName(navigator.userAgent),
      micLevel: peak,
      turn,
      inVoice,
      peers: stats.map((stat) => ({ ...stat, name: nameOf(stat.userId) })),
    })
    setReport(text)
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
    } catch {
      setCopied('no')
    }
  }, [inVoice, peerStats, peak, turn, nameOf])

  return (
    <section className="settings-section conn-test" aria-labelledby="settings-conn" data-testid="conn-test">
      <h3 id="settings-conn">Bağlantı testi</h3>

      <div className="conn-row">
        <span className="conn-label">Mikrofon</span>
        <span className="conn-meter" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, (level ?? 0) * 1.5) * 100)}%` }} />
        </span>
        <span className="conn-value" data-testid="conn-mic-level" data-level={level ?? ''} data-peak={peak ?? ''}>
          {listening ? micLevelText(level) : ''}
        </span>
        {listening ? (
          <button type="button" className="ghost" data-testid="conn-mic-stop" onClick={stopMic}>
            Durdur
          </button>
        ) : (
          <button type="button" className="ghost" data-testid="conn-mic-start" onClick={() => void startMic()}>
            Dinle
          </button>
        )}
      </div>
      {micError && <p className="settings-hint">{micError}</p>}
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="conn-loopback"
          disabled={!listening}
          checked={loopback}
          onChange={(event) => setLoopback(event.target.checked)}
        />
        <span>
          Kendini duy
          <small className="settings-hint">Kulaklıkla dene: hoparlörde yankı yapar. Kimseye gönderilmez.</small>
        </span>
      </label>
      <audio ref={loopAudio} hidden />

      <div className="conn-row">
        <span className="conn-label">TURN</span>
        <span className={`conn-turn ${turn}`} data-testid="conn-turn" data-state={turn}>
          {TURN_TEXT[turn]}
        </span>
        <button
          type="button"
          className="ghost"
          data-testid="conn-turn-retry"
          disabled={turn === 'checking'}
          onClick={() => void runProbe()}
        >
          Yeniden dene
        </button>
      </div>

      {inVoice && (
        <table className="conn-peers" data-testid="conn-peers">
          <thead>
            <tr>
              <th scope="col">Kişi</th>
              <th scope="col">Bağlantı</th>
              <th scope="col">Gecikme</th>
              <th scope="col">Kayıp</th>
            </tr>
          </thead>
          <tbody>
            {peers.length === 0 ? (
              <tr>
                <td colSpan={4} className="settings-hint">
                  Odada başka kimse yok.
                </td>
              </tr>
            ) : (
              peers.map((peer) => (
                <tr key={peer.userId} data-testid={`conn-peer-${peer.userId}`} data-path={peer.path ?? ''}>
                  <td>{nameOf(peer.userId)}</td>
                  <td>{pathText(peer.path)}</td>
                  <td>{rttText(peer.rtt)}</td>
                  <td>{lossText(peer.packetsLost, peer.packetsReceived)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      <div className="conn-row">
        <button type="button" className="conn-copy" data-testid="conn-report" onClick={() => void copyReport()}>
          Raporu kopyala
        </button>
        {copied === 'yes' && <span className="settings-hint">Kopyalandı.</span>}
        {copied === 'no' && <span className="settings-hint">Kopyalanamadı; metni aşağıdan seç.</span>}
      </div>
      {report && (
        <textarea className="conn-report" data-testid="conn-report-text" readOnly rows={8} value={report} />
      )}
    </section>
  )
}

/** CONTRACT-V4 A4: "Sesler" (master switch and volume) and "Rahatsız etme". */
export function SoundsSection({
  cuesEnabled,
  cueVolume,
  doNotDisturb,
  onChange,
}: {
  cuesEnabled: boolean
  cueVolume: number
  doNotDisturb: boolean
  onChange: (patch: { cuesEnabled?: boolean; cueVolume?: number; doNotDisturb?: boolean }) => void
}) {
  return (
    <section className="settings-section" aria-labelledby="settings-sounds">
      <h3 id="settings-sounds">Sesler</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-cues"
          checked={cuesEnabled}
          onChange={(event) => onChange({ cuesEnabled: event.target.checked })}
        />
        <span>
          Uyarı sesleri
          <small className="settings-hint">Sessize alma, kulaklık, odaya giren ve çıkan, çağrı.</small>
        </span>
      </label>
      <label className="settings-range">
        <span>Ses düzeyi</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          data-testid="settings-cue-volume"
          disabled={!cuesEnabled}
          value={Math.round(cueVolume * 100)}
          onChange={(event) => onChange({ cueVolume: Number(event.target.value) / 100 })}
        />
        <span className="conn-value">%{Math.round(cueVolume * 100)}</span>
      </label>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-dnd"
          checked={doNotDisturb}
          onChange={(event) => onChange({ doNotDisturb: event.target.checked })}
        />
        <span>
          Rahatsız etme
          <small className="settings-hint">Çağrılar zil çalmadan, yalnız şerit olarak görünür; odaya giriş bildirimleri sessiz gelir.</small>
        </span>
      </label>
    </section>
  )
}
