/**
 * Sharing music (CONTRACT-V8-MUSIC): Ece plays something from her computer,
 * the room sees the note mark and "Şu an çalıyor", her microphone goes off and
 * the music keeps playing, and each listener sets the music's level for
 * themselves (0–100 %, 50 % to start, as in the app). The visitor's slider is that level.
 */
import { useState } from 'react'
import { Avatar, BARIS, DemoControls, DENIZ, demoAttributes, ECE, Icon, OZAN, SELIN } from './parts'
import { useDemo } from './useDemo'

export const MUSIC_STEPS = [1300, 1500, 1700, 1900, 1700, 2600]
const TITLE = "Gece Otobüsü — Kadıköy'e Son Sefer"
/** The level the script sets at step 4 (Deniz turns it down a little), unless the visitor has touched it. */
const SCRIPTED = [50, 50, 50, 50, 30, 30]
/** A bass-heavy spectrum: tall on the left, falling off. */
const BAR_SHAPE = [0.95, 1, 0.9, 0.8, 0.85, 0.7, 0.75, 0.6, 0.65, 0.55, 0.5, 0.55, 0.45, 0.4, 0.42, 0.35, 0.3, 0.25]

export function MusicDemo() {
  const demo = useDemo<HTMLDivElement>(MUSIC_STEPS)
  const { step } = demo
  const [own, setOwn] = useState<number | null>(null)
  const level = own ?? SCRIPTED[step]
  const sharing = step >= 1
  const titled = step >= 2
  const eceMicOff = step >= 3
  const ozanTalking = step === 2 || step === 5

  return (
    <div className="music-demo" ref={demo.ref} {...demoAttributes(demo, 'music')} data-level={level}>
      <div className="mu" role="group" aria-label="Müzik paylaşımı: canlandırılmış örnek">
        <p className="mu-room">
          <Icon name="speaker" size={15} /> Sohbet
        </p>
        <ul className="mu-people">
          <li className={sharing ? 'mu-row is-sharing' : 'mu-row'}>
            <Avatar friend={ECE} size={34} />
            <span className="mu-who">
              <b>
                Ece
                {eceMicOff && (
                  <span className="mu-micoff" title="Mikrofonu kapalı">
                    <Icon name="micOff" size={13} />
                  </span>
                )}
              </b>
              <span className={titled ? 'mu-now is-on' : 'mu-now'} data-testid="music-now">
                <Icon name="note" size={12} /> {titled ? `Şu an çalıyor: ${TITLE}` : ' '}
              </span>
            </span>
            {sharing && (
              <span className="mu-mark" title="Müzik paylaşıyor">
                <Icon name="note" size={16} />
              </span>
            )}
          </li>
          <li className="mu-row">
            <Avatar friend={OZAN} size={34} speaking={ozanTalking} />
            <span className="mu-who">
              <b>Ozan</b>
            </span>
          </li>
          {[SELIN, BARIS].map((friend) => (
            <li className="mu-row" key={friend.name}>
              <Avatar friend={friend} size={34} speaking={friend === SELIN && step === 4} />
              <span className="mu-who">
                <b>{friend.name}</b>
              </span>
            </li>
          ))}
          <li className="mu-row">
            <Avatar friend={DENIZ} size={34} />
            <span className="mu-who">
              <b>Deniz (sen)</b>
            </span>
          </li>
        </ul>

        <div
          className={sharing ? 'mu-meter is-on' : 'mu-meter'}
          aria-hidden="true"
          style={{ ['--music' as string]: String(level / 50) }}
        >
          {['L', 'R'].map((side) => (
            <div className="mu-channel" key={side}>
              <span>{side}</span>
              <div className="mu-bars">
                {Array.from({ length: 18 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      animationDelay: `${(i * 137 + (side === 'R' ? 61 : 0)) % 900}ms`,
                      ['--h' as string]: String(BAR_SHAPE[(i + (side === 'R' ? 3 : 0)) % BAR_SHAPE.length]),
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <label className="mu-slider">
          <span>
            <Icon name="note" size={14} /> Ece'nin müziği
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={level}
            data-testid="music-volume"
            aria-valuetext={level === 0 ? 'susturuldu' : `yüzde ${level}`}
            onChange={(event) => setOwn(Number(event.target.value))}
            onPointerDown={() => demo.hold('drag', true)}
            onPointerUp={() => demo.hold('drag', false)}
            onBlur={() => demo.hold('drag', false)}
          />
          <output data-testid="music-level">{level === 0 ? 'Sessiz' : `%${level}`}</output>
        </label>
        <p className="mu-note" aria-live="polite">
          {eceMicOff
            ? 'Ece mikrofonunu kapattı; müzik çalmaya devam ediyor.'
            : sharing
              ? 'Ece müzik paylaşıyor, stereo.'
              : 'Ece “Müzik paylaş”a basıyor…'}
        </p>
      </div>
      <DemoControls demo={demo} label="Müzik paylaşımı örneği" />
    </div>
  )
}
