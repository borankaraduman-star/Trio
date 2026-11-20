/**
 * The voice room: five people talking, the server restarting under them and
 * the call carrying on (CONTRACT-V4: "ses sürüyor"). The visitor is Deniz: the
 * microphone is theirs to mute, Ozan's volume theirs to set (0–200 %).
 */
import { useState } from 'react'
import { Avatar, BARIS, DemoControls, DENIZ, demoAttributes, ECE, Icon, OZAN, SELIN, type Friend } from './parts'
import { useDemo } from './useDemo'

export const VOICE_STEPS = [1500, 1500, 1100, 2600, 1500, 1600, 2200]

/** Who is in the room, in the order the tiles are drawn. */
export const ROOM: Friend[] = [OZAN, ECE, SELIN, BARIS, DENIZ]
const SPEAKING: Friend[][] = [[OZAN], [ECE], [OZAN, SELIN], [BARIS], [ECE], [DENIZ], []]
const RESTARTING = 3

export function VoiceDemo() {
  const demo = useDemo<HTMLDivElement>(VOICE_STEPS)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(100)
  const speaking = SPEAKING[demo.step].filter((f) => !(f === DENIZ && muted))
  const deafenedOzan = volume === 0

  return (
    <div className="voice-demo" ref={demo.ref} {...demoAttributes(demo, 'voice')} data-muted={muted}>
      <div className="vr" role="group" aria-label="Sesli oda: canlandırılmış örnek">
        <div className="vr-head">
          <span className="vr-room">
            <Icon name="speaker" size={16} /> Sohbet
          </span>
          <span className="vr-count">{ROOM.length} kişi</span>
        </div>
        <p className={demo.step === RESTARTING ? 'vr-band is-on' : 'vr-band'} role="status" data-testid="voice-band">
          {demo.step === RESTARTING ? 'Sunucuya yeniden bağlanılıyor… ses sürüyor' : ''}
        </p>
        <ul className="vr-tiles">
          {ROOM.map((friend) => {
            const talking = speaking.includes(friend) && !(friend === OZAN && deafenedOzan)
            const scale = friend === OZAN ? volume / 100 : 1
            return (
              <li
                key={friend.name}
                className={talking ? 'vr-tile is-talking' : 'vr-tile'}
                data-testid={`voice-tile-${friend.name}`}
                data-speaking={talking}
              >
                <span className="vr-ring" style={{ ['--level' as string]: String(Math.min(2, scale)) }}>
                  <Avatar friend={friend} size={56} speaking={talking} />
                </span>
                <span className="vr-name">
                  {friend === DENIZ ? 'Deniz (sen)' : friend.name}
                  {friend === DENIZ && muted && (
                    <span className="vr-muted" aria-label="sessizde">
                      <Icon name="micOff" size={14} />
                    </span>
                  )}
                </span>
                <span className="vr-eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {friend === OZAN && <span className="vr-volume-tag">%{volume}</span>}
              </li>
            )
          })}
        </ul>
        <div className="vr-tools">
          <label className="vr-slider">
            <span>Ozan'ın sesi</span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={volume}
              data-testid="voice-volume"
              aria-valuetext={`yüzde ${volume}`}
              onChange={(event) => setVolume(Number(event.target.value))}
              onPointerDown={() => demo.hold('drag', true)}
              onPointerUp={() => demo.hold('drag', false)}
              onBlur={() => demo.hold('drag', false)}
            />
            <output>%{volume}</output>
          </label>
        </div>
        <div className="vr-bar">
          <button
            type="button"
            className={muted ? 'vr-btn is-off' : 'vr-btn'}
            aria-pressed={muted}
            aria-label={muted ? 'Mikrofonu aç' : 'Sessize al'}
            data-testid="voice-mute"
            onClick={() => setMuted((m) => !m)}
          >
            <Icon name={muted ? 'micOff' : 'mic'} size={20} />
          </button>
          <span className="vr-btn" aria-hidden="true">
            <Icon name="headphones" size={20} />
          </span>
          <span className="vr-btn" aria-hidden="true">
            <Icon name="camera" size={20} />
          </span>
          <span className="vr-btn" aria-hidden="true">
            <Icon name="screen" size={20} />
          </span>
          <span className="vr-btn vr-leave" aria-hidden="true">
            <Icon name="leave" size={20} />
          </span>
        </div>
      </div>
      <DemoControls demo={demo} label="Sesli oda örneği" />
    </div>
  )
}
