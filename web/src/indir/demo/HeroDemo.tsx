/**
 * The hero: Trio's main screen, redrawn, playing an ordinary evening on a
 * group's server. People drop into the voice room one by one, messages
 * arrive, a reaction lands, a photo comes in, and they talk. The visitor can
 * write into the chat.
 */
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import { BrandMark } from '../../components/BrandMark'
import {
  Avatar,
  BARIS,
  DemoControls,
  DENIZ,
  demoAttributes,
  ECE,
  Icon,
  MELIS,
  OZAN,
  SELIN,
  SEN,
  type Friend,
} from './parts'
import { upTo } from './player'
import { useDemo } from './useDemo'

/** How long each step is held (ms). Index = step. */
export const HERO_STEPS = [700, 900, 1100, 1500, 1000, 1500, 900, 1300, 1300, 900, 1500, 900, 1500, 1000, 1300, 1400, 3600]

interface Line {
  at: number
  who: Friend
  text?: string
  photo?: boolean
}

const LINES: Line[] = [
  { at: 0, who: SELIN, text: "Cumartesi için halı sahayı ayırttım. On kişi lazım, şu an yediyiz." },
  { at: 0, who: BARIS, text: 'Ben varım. Kaleye kimse geçmezse yine ben geçerim, söylene söylene.' },
  { at: 3, who: OZAN, text: "22.00'de oyun var, odaya gelin. Geç kalan kahve ısmarlıyor." },
  { at: 5, who: ECE, text: 'Ben 22.15 derim, makarna daha ocakta.' },
  { at: 7, who: DENIZ, text: "O zaman kahveler Ece'den." },
  { at: 10, who: MELIS, text: "Yarınki toplantının notlarını #planlar'a koydum. Okuyan bir emoji bıraksın." },
  { at: 12, who: ECE, photo: true },
]

/** Who is typing at a step. */
const TYPING: Record<number, Friend> = { 2: OZAN, 4: ECE, 6: DENIZ, 9: MELIS, 11: ECE }

/** When each person joins the voice room. */
const JOINS: { at: number; who: Friend }[] = [
  { at: 1, who: OZAN },
  { at: 4, who: ECE },
  { at: 6, who: BARIS },
  { at: 13, who: SELIN },
  { at: 14, who: DENIZ },
]

const SPEAKING: Record<number, Friend[]> = { 14: [OZAN], 15: [ECE, BARIS], 16: [OZAN, SELIN] }

const REPLIES = [
  'Hoş geldin. Kahve sırası sende o zaman.',
  "Bunu Ece'ye de söyle, inanmaz.",
  "Tamam, 22.00'de odadayız.",
]

const TIMES = ['20:12', '20:20', '21:42', '21:43', '21:43', '21:44', '21:45']
/** Where the "Yeni mesajlar" line sits (CONTRACT-V7-READING): before the first message that arrives live. */
const FIRST_NEW = 2

export function HeroDemo() {
  const demo = useDemo<HTMLDivElement>(HERO_STEPS)
  const { step } = demo
  const [typed, setTyped] = useState('')
  const [mine, setMine] = useState<{ who: Friend; text: string }[]>([])
  const replyTimer = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The loop starting again clears what the visitor wrote.
  useEffect(() => {
    if (step === 0) setMine([])
  }, [step])

  useEffect(
    () => () => {
      if (replyTimer.current !== null) window.clearTimeout(replyTimer.current)
    },
    [],
  )

  const lines = upTo(LINES, step)
  const typing = TYPING[step]
  const voice = upTo(JOINS, step).map((j) => j.who)
  const speaking = SPEAKING[step] ?? []
  const reacted = step >= 8

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [lines.length, mine.length, typing])

  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = typed.trim().slice(0, 140)
    if (!text) return
    setTyped('')
    setMine((current) => [...current, { who: SEN, text }])
    const count = mine.filter((m) => m.who === SEN).length
    if (replyTimer.current !== null) window.clearTimeout(replyTimer.current)
    replyTimer.current = window.setTimeout(() => {
      setMine((current) => [...current, { who: OZAN, text: REPLIES[count % REPLIES.length] }])
    }, 1300)
  }

  return (
    <div className="hero-demo" ref={demo.ref} {...demoAttributes(demo, 'hero')}>
      <div className="dw" role="group" aria-label="Trio'nun ana ekranı: canlandırılmış örnek">
        <div className="dw-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <b>Trio</b>
        </div>
        <div className="dw-body">
          <aside className="dw-side" aria-hidden="true">
            <div className="dw-brand">
              <BrandMark size={18} />
              Trio
            </div>
            <p className="dw-section">Metin kanalları</p>
            <p className="dw-channel is-active">
              <Icon name="hash" size={14} /> genel
            </p>
            <p className="dw-channel">
              <Icon name="hash" size={14} /> planlar
            </p>
            <p className="dw-section">Ses kanalları</p>
            <p className="dw-channel dw-voice">
              <Icon name="speaker" size={14} /> Sohbet
            </p>
            <ul className="dw-voice-list" data-testid="hero-voice-list">
              {voice.map((who) => (
                <li key={who.name} className="dw-join">
                  <Avatar friend={who} size={20} speaking={speaking.includes(who)} />
                  {who.name}
                </li>
              ))}
            </ul>
            {voice.includes(DENIZ) && (
              <div className="dw-connected">
                <b>Ses bağlı</b>
                <span>Sohbet</span>
              </div>
            )}
          </aside>
          <section className="dw-chat">
            <header className="dw-head" aria-hidden="true">
              <Icon name="hash" size={16} /> genel
              <span className="dw-head-people">
                {voice.map((who) => (
                  <Avatar key={who.name} friend={who} size={18} speaking={speaking.includes(who)} />
                ))}
              </span>
            </header>
            <div className="dw-messages" ref={listRef} aria-live="off" data-testid="hero-messages">
              {lines.map((line, index) => (
                <Fragment key={`${line.at}-${index}`}>
                  {index === FIRST_NEW && (
                    <p className="dw-new" aria-hidden="true">
                      <span>Yeni mesajlar</span>
                    </p>
                  )}
                  <div className="dw-msg">
                    <Avatar friend={line.who} size={30} />
                    <div className="dw-msg-body">
                      <p className="dw-msg-meta">
                        <b>{line.who.name}</b> <time>{TIMES[index]}</time>
                      </p>
                      {line.text && <p className="dw-msg-text">{line.text}</p>}
                      {line.photo && <PastaPhoto />}
                      {line.who === DENIZ && line.at > 0 && reacted && (
                        <span className="dw-reaction" title="Ozan, Ece ve Selin">
                          😂 <b>3</b>
                        </span>
                      )}
                    </div>
                  </div>
                </Fragment>
              ))}
              {mine.map((line, index) => (
                <div className="dw-msg" key={`mine-${index}`} data-testid="hero-visitor-message">
                  <Avatar friend={line.who} size={30} />
                  <div className="dw-msg-body">
                    <p className="dw-msg-meta">
                      <b>{line.who.name}</b> <time>şimdi</time>
                    </p>
                    <p className="dw-msg-text">{line.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="dw-typing" aria-hidden="true">
              {typing ? (
                <>
                  <span className="dw-typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {typing.name} yazıyor…
                </>
              ) : null}
            </p>
            <form className="dw-composer" onSubmit={send}>
              <label className="sr-only" htmlFor="hero-composer">
                Örnek sohbete bir şey yaz
              </label>
              <input
                id="hero-composer"
                data-testid="hero-composer"
                value={typed}
                maxLength={140}
                autoComplete="off"
                placeholder="Mesaj yaz… (#genel)"
                onChange={(event) => setTyped(event.target.value)}
                onFocus={() => demo.hold('typing', true)}
                onBlur={() => demo.hold('typing', false)}
              />
              <button type="submit" disabled={!typed.trim()} data-testid="hero-send">
                Gönder
              </button>
            </form>
          </section>
        </div>
      </div>
      <DemoControls demo={demo} label="Ana ekran örneği" />
    </div>
  )
}

/** The photo Ece sends: drawn, so it costs a few hundred bytes. */
function PastaPhoto() {
  return (
    <figure className="dw-photo">
      <svg viewBox="0 0 240 150" role="img" aria-label="Ocakta kaynayan bir tencere makarna">
        <rect width="240" height="150" fill="#2a2420" />
        <rect y="112" width="240" height="38" fill="#3a3029" />
        <ellipse cx="120" cy="114" rx="70" ry="10" fill="#1b1714" />
        <path d="M60 64h120v40a14 14 0 0 1-14 14H74a14 14 0 0 1-14-14z" fill="#9aa3ad" />
        <rect x="52" y="58" width="136" height="10" rx="5" fill="#b8c0c8" />
        <path d="M44 72h16M180 72h16" stroke="#7b838c" strokeWidth="6" strokeLinecap="round" />
        <path
          className="dw-steam"
          d="M96 50c-8-10 8-14 0-26M120 48c-8-10 8-14 0-26M144 50c-8-10 8-14 0-26"
          stroke="#f2f1ed"
          strokeOpacity=".45"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
        />
        <ellipse cx="120" cy="64" rx="56" ry="5" fill="#e8c27a" />
        <circle cx="200" cy="30" r="10" fill="#ee997f" fillOpacity=".35" />
      </svg>
      <figcaption>makarna.webp · 214 KB</figcaption>
    </figure>
  )
}
