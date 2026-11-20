import { useEffect, useState, type ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'
import { HeroDemo } from './demo/HeroDemo'
import { MusicDemo } from './demo/MusicDemo'
import { PhoneDemo } from './demo/PhoneDemo'
import { useReducedMotion } from './demo/useDemo'
import { PhotoVignette, ServerVignette, ShareProfilesVignette, VoiceMessageVignette } from './demo/Vignettes'
import { VoiceDemo } from './demo/VoiceDemo'
import { FileRow, PhoneCard, PrimaryButton, WarningHelp } from './downloads'
import {
  detectVisitor,
  formatDate,
  otherFiles,
  primaryFile,
  readDownloads,
  type Downloads,
  type Visitor,
} from './platform'
import { Dots, useReveal } from './reveal'

const REPO_URL = 'https://github.com/borankaraduman-star/Trio'

type Load = { state: 'loading' } | { state: 'ready'; downloads: Downloads }

/** What the browser will say about itself; every hint is optional and may be refused. */
async function visitorHints(): Promise<Visitor> {
  const nav = navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> }
  }
  let architecture: string | null = null
  try {
    architecture = (await nav.userAgentData?.getHighEntropyValues?.(['architecture']))?.architecture ?? null
  } catch {
    architecture = null
  }
  let gpu: string | null = null
  if (/Macintosh/i.test(nav.userAgent) && !architecture) {
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl?.getExtension('WEBGL_debug_renderer_info')
      gpu = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null
    } catch {
      gpu = null
    }
  }
  return detectVisitor({ userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints, architecture, gpu })
}

/**
 * /indir: Trio's one public page (CONTRACT-V6-DOWNLOAD). What Trio is, shown
 * by small live demos of the real screens, then the download itself.
 */
export function DownloadPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [visitor, setVisitor] = useState<Visitor>(() =>
    detectVisitor({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }),
  )
  const reduced = useReducedMotion()
  const rootRef = useReveal<HTMLDivElement>(reduced)

  useEffect(() => {
    let live = true
    void visitorHints().then((v) => live && setVisitor(v))
    fetch('/api/downloads', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((raw: unknown) => live && setLoad({ state: 'ready', downloads: readDownloads(raw) }))
    return () => {
      live = false
    }
  }, [])

  const downloads = load.state === 'ready' ? load.downloads : null
  const files = downloads?.files ?? []
  const primary = primaryFile(visitor, files)
  const others = otherFiles(files, primary)
  const unavailable = downloads !== null && files.length === 0
  const date = formatDate(downloads?.published_at ?? null)
  const phone = visitor === 'phone'

  return (
    <div
      className="indir"
      ref={rootRef}
      data-testid="indir"
      data-visitor={visitor}
      data-state={load.state}
      data-motion={reduced ? 'reduced' : 'full'}
    >
      <a className="skip" href="#indir">
        İndirmeye geç
      </a>
      <header className="top">
        <a href="/" className="top-brand">
          <BrandMark size={26} className="living" />
          <span>Trio</span>
        </a>
        <nav className="top-nav" aria-label="Sayfa">
          <a href="#oda">Neler var</a>
          <a href="#baslangic">Nasıl başlanır</a>
          <a href="#indir">İndir</a>
          <a href="/" className="top-open">
            Tarayıcıda aç
          </a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow hero-in" style={{ ['--d' as string]: '0ms' }}>
              <Dots /> üç arkadaş için
            </p>
            <h1 id="hero-title" className="hero-title">
              <span className="hero-in" style={{ ['--d' as string]: '80ms' }}>
                Üç kişiyiz,
              </span>{' '}
              <span className="hero-in hero-accent" style={{ ['--d' as string]: '200ms' }}>
                bir odamız var.
              </span>
            </h1>
            <p className="hero-lead hero-in" style={{ ['--d' as string]: '320ms' }}>
              Yazışmak, sesli konuşmak, ekranını açmak, birbirine şarkı çalmak için küçük bir oda. Trio arkadaşının
              kurduğu sunucuda durur; içeri davet koduyla girilir.
            </p>

            <div className="hero-actions hero-in" style={{ ['--d' as string]: '440ms' }}>
              {load.state === 'loading' && !phone && (
                <p className="muted" role="status">
                  Dosyalar yükleniyor…
                </p>
              )}
              {phone ? (
                <PhoneCard />
              ) : (
                downloads && (
                  <>
                    {unavailable && (
                      <p className="indir-unavailable" role="status" data-testid="indir-unavailable">
                        İndirmeler şu an kullanılamıyor. Biraz sonra tekrar dene; bu arada Trio'yu tarayıcıda
                        kullanabilirsin.
                      </p>
                    )}
                    {primary && <PrimaryButton file={primary} version={downloads.version} date={date} />}
                    {!primary && !unavailable && (
                      <p className="muted" data-testid="indir-no-match">
                        Cihazını tanıyamadık; aşağıdan sana uyan dosyayı seç.
                      </p>
                    )}
                  </>
                )
              )}
              {!phone && (
                <div className="hero-browser">
                  <a href="/" className="button-ghost" data-testid="indir-browser">
                    Kurmadan kullan: tarayıcıda aç
                  </a>
                  <p className="muted">
                    Kurulum yok, uyarı yok. Tek farkı: tarayıcıda bas-konuş tuşu yalnız Trio sekmesi öndeyken çalışır.
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="hero-stage hero-in" style={{ ['--d' as string]: '260ms' }}>
            <HeroDemo />
          </div>
        </section>

        <section className="feature feature-voice" id="oda" aria-labelledby="voice-title">
          <div className="feature-copy" data-reveal>
            <p className="eyebrow">
              <Dots /> Sesli oda
            </p>
            <h2 id="voice-title">Sunucu yeniden başlasa da sesiniz kesilmez.</h2>
            <p>
              Ses arkadaşından sana gider, sunucunun üstünden geçmez; sunucu yalnızca sizi tanıştırır. Güncelleme gelip
              sunucu yeniden başlarken üstte “ses sürüyor” yazar, siz konuşmaya devam edersiniz.
            </p>
            <ul className="ticks">
              <li>Herkesin sesini ayrı ayarla: %0 ile %200 arası, bu cihazda hatırlanır.</li>
              <li>Gürültü engelleme ve bas-konuş; masaüstünde pencere arkadayken de.</li>
              <li>“Çağır”a bas: odada olmayan arkadaşının telefonu çalar.</li>
            </ul>
            <p className="try">Dene: kendi mikrofonunu kapat, Ozan'ın sesini kıs.</p>
          </div>
          <div className="feature-demo" data-reveal>
            <VoiceDemo />
          </div>
        </section>

        <section className="feature feature-music" aria-labelledby="music-title">
          <div className="feature-demo" data-reveal>
            <MusicDemo />
          </div>
          <div className="feature-copy" data-reveal>
            <p className="eyebrow">
              <Dots /> Müzik paylaş
            </p>
            <h2 id="music-title">Senin çaldığını oda da duysun.</h2>
            <p>
              Bilgisayarında çalan sesi (Spotify, bir YouTube sekmesi…) odadaki herkese stereo gönder. Mikrofonunu
              kapatsan da müzik çalmaya devam eder; herkes müziğin sesini kendine göre ayarlar.
            </p>
            <p className="muted">
              Windows 11 masaüstü uygulamasında tek tıkla sistem sesi; Chrome ve Edge'de müziğin çaldığı sekme. Şarkının
              adını göstermek isteğe bağlı.
            </p>
          </div>
        </section>

        <section className="feature feature-phone" aria-labelledby="phone-title">
          <div className="feature-copy" data-reveal>
            <p className="eyebrow">
              <Dots /> Telefonda
            </p>
            <h2 id="phone-title">Uygulama mağazası yok, Trio yine cebinde.</h2>
            <p>
              Telefonda Trio tarayıcıdan çalışır; ana ekrana eklersen simgesiyle açılır. Trio kapalıyken de yeni
              mesajlar, seni ananlar ve çağrılar bildirim olarak gelir.
            </p>
            <p>Görüşmedeyken alttaki şerit kimin konuştuğunu gösterir; sessize almak ya da çıkmak tek dokunuş.</p>
            <p className="muted">iPhone'da bildirim almak için önce Trio'yu ana ekrana ekle.</p>
          </div>
          <div className="feature-demo" data-reveal>
            <PhoneDemo />
          </div>
        </section>

        <section className="details" aria-labelledby="details-title">
          <div className="details-head" data-reveal>
            <p className="eyebrow">
              <Dots /> Bir de şunlar
            </p>
            <h2 id="details-title">Küçük ama düşünülmüş.</h2>
          </div>
          <div className="bento">
            <article className="bento-item bento-share" data-reveal>
              <ShareProfilesVignette />
              <h3>Ekranını neye göre paylaşacağını seç</h3>
              <p>Oyunda akıcılık, kodda keskin yazı. İzlemek istemeyen izlemeyi bırakır; görüntü ona gönderilmez.</p>
            </article>
            <article className="bento-item bento-voice" data-reveal>
              <VoiceMessageVignette />
              <h3>Sesli mesaj</h3>
              <p>Yazmaya üşenince: mikrofona basılı tut, konuş, bırak. Yarım kalan mesajın da kaybolmaz.</p>
            </article>
            <article className="bento-item bento-photo" data-reveal>
              <PhotoVignette />
              <h3>Fotoğrafın konumu gitmez, silinir</h3>
              <p>
                Gönderdiğin fotoğraf küçültülür ve içindeki konum bilgisi silinir; sohbette hızlı açılır. İstersen
                “Orijinali gönder”.
              </p>
            </article>
            <article className="bento-item bento-server" data-reveal>
              <ServerVignette />
              <div className="bento-text">
                <h3>Sunucu sizin</h3>
                <p>
                  Mesajlar ve dosyalar arkadaşının kurduğu sunucuda durur. Reklam yok, e-posta ya da telefon numarası
                  istenmez.
                </p>
              </div>
            </article>
          </div>
        </section>

        <section className="steps" id="baslangic" aria-labelledby="steps-title">
          <div className="steps-head" data-reveal>
            <p className="eyebrow">
              <Dots /> Nasıl başlanır
            </p>
            <h2 id="steps-title">Üç adımda odadasın.</h2>
          </div>
          <ol className="steps-list" data-reveal>
            <li>
              <h3>İndir ya da tarayıcıda aç</h3>
              <p>Windows, macOS ve Linux için uygulama var. Telefonda ve kurmak istemeyen için tarayıcı yeter.</p>
            </li>
            <li>
              <h3>Davet koduyla katıl</h3>
              <p>
                Kodu sunucuyu kuran arkadaşından al, bir isim yaz. Başka cihazdan aynı hesapla girmek için cihaz kodu
                var.
              </p>
            </li>
            <li>
              <h3>Odaya gir</h3>
              <p>“Sohbet”e tıkla. Arkadaşların oradaysa sesleri hemen gelir.</p>
            </li>
          </ol>
        </section>

        <section className="files" id="indir" aria-labelledby="files-title" tabIndex={-1}>
          <div className="files-head" data-reveal>
            <p className="eyebrow">
              <Dots /> İndir
            </p>
            <h2 id="files-title">{phone ? 'Masaüstü dosyaları' : 'Tüm dosyalar'}</h2>
            {downloads?.version && (
              <p className="muted" data-testid="indir-version">
                Sürüm {downloads.version}
                {date ? ` · ${date}` : ''} · dosyalar Trio'nun GitHub sürüm sayfasından gelir
              </p>
            )}
          </div>
          {load.state === 'loading' && (
            <p className="muted" role="status">
              Dosyalar yükleniyor…
            </p>
          )}
          {unavailable && (
            <p className="muted files-empty">
              Şu an listelenecek dosya yok. Trio'yu <a href="/">tarayıcıda</a> kullanabilirsin.
            </p>
          )}
          {downloads && files.length > 0 && (
            <ul className="indir-files" data-testid="indir-files">
              {(primary ? [primary, ...others] : others).map((file) => (
                <FileRow key={file.platform} file={file} primary={file === primary} />
              ))}
            </ul>
          )}
          {downloads && files.length > 0 && !phone && <WarningHelp downloads={downloads} visitor={visitor} />}
        </section>

        <section className="faq" aria-labelledby="faq-title">
          <div className="faq-head" data-reveal>
            <p className="eyebrow">
              <Dots /> Sık sorulanlar
            </p>
            <h2 id="faq-title">Aklına takılan</h2>
          </div>
          <div className="faq-list" data-reveal>
            <Question q="Ücretsiz mi?">
              Evet. Trio'yu kullanmak için kimseye para ödemezsin, reklam da yok. Sunucunun barındırıldığı yerin (ör.
              Railway) küçük bir aylık ücreti olabilir; onu sunucuyu kuran öder.
            </Question>
            <Question q="Verilerim nerede duruyor?">
              Mesajlar ve dosyalar, Trio'yu kuran arkadaşının sunucusunda durur; Trio'nun ayrıca bir bulutu yok.
              Sunucuda şifresiz saklanırlar, yani sunucuyu yöneten görebilir. Canlı ses, kamera ve ekran tarayıcılar
              arasında şifreli gider ve kaydedilmez.
            </Question>
            <Question q="Telefonda var mı?">
              Ayrı bir uygulama yok, gerekmiyor: Trio telefonun tarayıcısında çalışır. Ana ekrana eklersen simgesiyle
              açılır ve bildirim alırsın; iPhone'da bildirim için ana ekrana eklemek şart.
            </Question>
            <Question q="Windows neden uyarı veriyor?">
              {downloads?.signed.windows
                ? 'Windows dosyası imzalı. Yine de yeni bir sürüm ilk günlerinde SmartScreen uyarısı görebilirsin: imza tek başına “tanınmış uygulama” itibarı kazandırmaz. Ne yapacağın yukarıda, “Kurulumda uyarı çıkarsa” bölümünde.'
                : 'Masaüstü uygulaması Microsoft ya da Apple’ın ücretli geliştirici sertifikasıyla imzalanmadı; sistem yayımcıyı tanımadığı için ilk açılışta uyarır. Uyarı dosyanın zararlı olduğu anlamına gelmez. Ne yapacağın ve dosyayı nasıl doğrulayacağın yukarıda, “Kurulumda uyarı çıkarsa” bölümünde.'}
            </Question>
            <Question q="Nasıl güncellenir?">
              Tarayıcıda bir şey yapman gerekmez: sunucu güncellenince Trio da güncellenir. Masaüstü uygulaması da
              ekranlarını sunucudan yüklediği için yenilikler ona kendiliğinden gelir; uygulamanın kendisinin yeni
              sürümü çıkınca Ayarlar'da haber verilir, bu sayfadan indirip kurarsın.
            </Question>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-brand">
          <BrandMark size={22} className="living" />
          <span>
            Trio {__TRIO_VERSION__}
            {downloads?.version && downloads.version !== __TRIO_VERSION__ ? ` · masaüstü ${downloads.version}` : ''}
          </span>
        </div>
        <p className="foot-text">
          Birkaç arkadaşın kendi sunucusunda çalışan küçük bir sohbet uygulaması. Kaynak kodu herkese açık:{' '}
          <a href={REPO_URL} rel="noopener" data-testid="indir-repo">
            GitHub'da Trio
          </a>
          .
        </p>
        <a href="/" className="foot-open">
          Trio'yu aç
        </a>
      </footer>
    </div>
  )
}

function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="faq-item">
      <summary>{q}</summary>
      <p>{children}</p>
    </details>
  )
}
