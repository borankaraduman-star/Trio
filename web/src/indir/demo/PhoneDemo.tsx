/**
 * On the phone (CONTRACT-V6-PUSH, CONTRACT-V7-PHONE): notifications reach the
 * lock screen while Trio is closed, a call is a tap away, and in the call the
 * bar at the bottom says who is talking. The visitor switches between the lock
 * screen and the app.
 */
import { BrandMark } from '../../components/BrandMark'
import { Avatar, DemoControls, demoAttributes, ECE, Icon, OZAN, type Friend } from './parts'
import { useDemo } from './useDemo'

export const PHONE_STEPS = [900, 1600, 1800, 2400, 1700, 1900, 2800]
const LOCK_LAST = 3
const APP_STEP = 5
const TALKING: Record<number, Friend[]> = { 4: [OZAN], 5: [OZAN, ECE] }

export function PhoneDemo() {
  const demo = useDemo<HTMLDivElement>(PHONE_STEPS)
  const { step } = demo
  const lock = step <= LOCK_LAST
  const talking = TALKING[step] ?? []
  const callLine = talking.length > 0 ? `Konuşuyor: ${talking.map((f) => f.name).join(', ')}` : '3 kişi'

  return (
    <div className="phone-demo" ref={demo.ref} {...demoAttributes(demo, 'phone')} data-view={lock ? 'lock' : 'app'}>
      <div className="ph-switch" role="group" aria-label="Telefonda göster">
        <button type="button" aria-pressed={lock} onClick={() => demo.goTo(LOCK_LAST)} data-testid="phone-show-lock">
          Kilit ekranı
        </button>
        <button type="button" aria-pressed={!lock} onClick={() => demo.goTo(APP_STEP)} data-testid="phone-show-app">
          Uygulama
        </button>
      </div>
      <div className="ph" role="group" aria-label={lock ? 'Telefonun kilit ekranında Trio bildirimleri' : 'Telefonda Trio, görüşme şeridiyle'}>
        <div className="ph-notch" aria-hidden="true" />
        {lock ? (
          <div className="ph-lock" aria-hidden="true">
            <p className="ph-clock">22:07</p>
            <p className="ph-lock-date">Cuma, 20 Kasım</p>
            <div className="ph-notes">
              {step >= 3 && (
                <div className="ph-note ph-note-ring" key="ring">
                  <span className="ph-app">
                    <BrandMark size={14} /> Trio · şimdi
                  </span>
                  <b>Trio — sesli çağrı</b>
                  <span>Ozan seni Sohbet odasına çağırıyor</span>
                </div>
              )}
              {step >= 2 && (
                <div className="ph-note" key="msg">
                  <span className="ph-app">
                    <BrandMark size={14} /> Trio · {step >= 3 ? '1 dk' : 'şimdi'}
                  </span>
                  <b>Ece — #genel</b>
                  <span>Makarna bitti, 5 dakikaya odadayım.</span>
                </div>
              )}
              {step >= 1 && (
                <div className="ph-note" key="voice">
                  <span className="ph-app">
                    <BrandMark size={14} /> Trio · {step >= 2 ? '2 dk' : 'şimdi'}
                  </span>
                  <b>Ozan ses odasına girdi</b>
                  <span>🔊 Sohbet</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="ph-app-view" aria-hidden="true">
            <div className="ph-head">
              <span className="ph-menu" />
              <Icon name="hash" size={15} /> genel
              <span className="ph-people">
                <Avatar friend={OZAN} size={20} speaking={talking.includes(OZAN)} />
                <Avatar friend={ECE} size={20} speaking={talking.includes(ECE)} />
                <i /> 3
              </span>
            </div>
            <div className="ph-msgs">
              <p>
                <b>Ece</b> Makarna bitti, 5 dakikaya odadayım.
              </p>
              <p>
                <b>Ozan</b> Çağırdım, gel.
              </p>
              <p>
                <b>Deniz</b> Geldim geldim.
              </p>
            </div>
            <div className="ph-callbar" data-testid="phone-callbar">
              <span className="ph-call-text">
                <b>Sohbet</b>
                <span>{callLine}</span>
              </span>
              <span className="ph-call-btn">
                <Icon name="mic" size={15} />
              </span>
              <span className="ph-call-btn">
                <Icon name="headphones" size={15} />
              </span>
              <span className="ph-call-btn ph-leave">
                <Icon name="leave" size={15} />
              </span>
            </div>
            <div className="ph-composer">
              <span>Mesaj yaz… (#genel)</span>
              <b>Gönder</b>
            </div>
          </div>
        )}
      </div>
      <DemoControls demo={demo} label="Telefon örneği" />
    </div>
  )
}
