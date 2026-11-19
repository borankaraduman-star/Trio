import { useEffect, useState, type ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'
import {
  detectVisitor,
  family,
  formatDate,
  formatSize,
  otherFiles,
  PLATFORM_LABEL,
  PLATFORM_SHORT,
  powershellCheck,
  primaryFile,
  readDownloads,
  shellCheck,
  type DownloadFile,
  type Downloads,
  type Visitor,
} from './platform'

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

export function DownloadPage() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [visitor, setVisitor] = useState<Visitor>(() =>
    detectVisitor({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }),
  )

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

  return (
    <div className="indir" data-testid="indir" data-visitor={visitor} data-state={load.state}>
      <header className="indir-top">
        <a href="/" className="indir-brand">
          <BrandMark size={28} />
          <span>Trio</span>
        </a>
        <a href="/" className="indir-top-link">
          Tarayıcıda aç
        </a>
      </header>

      <main className="indir-main">
        <section className="indir-hero">
          <h1>Trio'yu indir</h1>
          <p className="indir-lead">
            Arkadaşlarınla yazış, konuş, ekranını paylaş. Masaüstü uygulamasında bas-konuş tuşu, pencere arkadayken de
            çalışır.
          </p>

          {load.state === 'loading' && (
            <p className="indir-muted" role="status">
              Dosyalar yükleniyor…
            </p>
          )}

          {visitor === 'phone' ? (
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
                  <p className="indir-muted" data-testid="indir-no-match">
                    Cihazını tanıyamadık; aşağıdan sana uyan dosyayı seç.
                  </p>
                )}
              </>
            )
          )}

          {visitor !== 'phone' && (
            <div className="indir-browser">
              <a href="/" className="indir-secondary" data-testid="indir-browser">
                Kurmadan kullan: tarayıcıda aç
              </a>
              <p className="indir-muted">
                Kurulum yok, uyarı yok. Tek farkı: tarayıcıda bas-konuş tuşu yalnız Trio sekmesi öndeyken çalışır.
              </p>
            </div>
          )}
        </section>

        {downloads && files.length > 0 && (
          <section className="indir-section" aria-labelledby="indir-files-title">
            <h2 id="indir-files-title">{visitor === 'phone' ? 'Masaüstü dosyaları' : 'Tüm dosyalar'}</h2>
            {downloads.version && (
              <p className="indir-muted">
                Sürüm {downloads.version}
                {date ? ` · ${date}` : ''}
              </p>
            )}
            <ul className="indir-files" data-testid="indir-files">
              {(primary ? [primary, ...others] : others).map((file) => (
                <FileRow key={file.platform} file={file} primary={file === primary} />
              ))}
            </ul>
          </section>
        )}

        {downloads && files.length > 0 && visitor !== 'phone' && (
          <WarningHelp downloads={downloads} visitor={visitor} />
        )}
      </main>

      <footer className="indir-footer">
        Trio, birkaç arkadaşın kendi sunucusunda çalışan küçük bir sohbet uygulaması. Mağazada değil; dosyalar Trio'nun
        GitHub'daki sürüm sayfasından gelir.
      </footer>
    </div>
  )
}

function PrimaryButton({ file, version, date }: { file: DownloadFile; version: string | null; date: string | null }) {
  return (
    <div className="indir-primary-wrap">
      <a
        href={file.url}
        className="indir-primary"
        data-testid="indir-primary"
        data-platform={file.platform}
        download
      >
        <DownloadIcon />
        {PLATFORM_SHORT[file.platform]} için indir
      </a>
      <p className="indir-meta" data-testid="indir-primary-meta">
        {[version && `Sürüm ${version}`, date, formatSize(file.size)].filter(Boolean).join(' · ')}
      </p>
    </div>
  )
}

function PhoneCard() {
  return (
    <div className="indir-phone" data-testid="indir-phone">
      <p className="indir-phone-title">Trio telefonda tarayıcıdan çalışır.</p>
      <p className="indir-muted">
        Telefon için ayrı bir uygulama yok, gerekmiyor: yazışma, sesli oda ve kamera tarayıcıda çalışır. Sık
        kullanacaksan tarayıcının menüsünden “Ana ekrana ekle”yi seç; Trio ana ekranında bir simge olarak durur.
      </p>
      <a href="/" className="indir-primary" data-testid="indir-open-app">
        Trio'yu aç
      </a>
    </div>
  )
}

function FileRow({ file, primary }: { file: DownloadFile; primary: boolean }) {
  return (
    <li className="indir-file" data-testid="indir-file" data-platform={file.platform}>
      <div className="indir-file-head">
        <div>
          <p className="indir-file-label">{PLATFORM_LABEL[file.platform]}</p>
          <p className="indir-file-name">
            {file.name} · {formatSize(file.size)}
          </p>
        </div>
        {!primary && (
          <a href={file.url} className="indir-small-button" download>
            İndir
          </a>
        )}
      </div>
      <div className="indir-sha">
        <span className="indir-sha-label">SHA-256</span>
        {file.sha256 ? (
          <>
            <code data-testid="indir-sha">{file.sha256}</code>
            <CopyButton text={file.sha256} label="Kopyala" />
          </>
        ) : (
          <span className="indir-muted">bu dosya için yayımlanmadı</span>
        )}
      </div>
    </li>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), 1800)
    return () => clearTimeout(timer)
  }, [done])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
    } catch {
      setDone(false)
    }
  }
  return (
    <button type="button" className="indir-copy" onClick={() => void copy()} data-testid="indir-copy">
      {done ? 'Kopyalandı' : label}
    </button>
  )
}

function Command({ text, testId }: { text: string; testId: string }) {
  return (
    <div className="indir-command">
      <code data-testid={testId}>{text}</code>
      <CopyButton text={text} label="Kopyala" />
    </div>
  )
}

function WarningHelp({ downloads, visitor }: { downloads: Downloads; visitor: Visitor }) {
  const byFamily = (name: 'windows' | 'mac' | 'linux') => downloads.files.filter((f) => family(f.platform) === name)
  const windows = byFamily('windows')[0]
  const macs = byFamily('mac')
  const mac = macs.find((f) => f.platform === visitor) ?? macs[0]
  const linux = byFamily('linux')[0]
  const mine = visitor === 'phone' || visitor === 'unknown' ? null : family(visitor)
  const unsignedSomewhere = (windows && !downloads.signed.windows) || (mac && !downloads.signed.mac)

  return (
    <section className="indir-section" aria-labelledby="indir-help-title" data-testid="indir-help">
      <h2 id="indir-help-title">Kurulumda uyarı çıkarsa</h2>
      {unsignedSomewhere && (
        <p data-testid="indir-why">
          Trio arkadaşlar arasında kullanılan özel bir uygulama ve Microsoft ya da Apple'ın ücretli geliştirici
          sertifikasıyla imzalanmadı. Bu yüzden işletim sistemi yayımcıyı tanımaz ve bir kez uyarır. Uyarı dosyanın
          zararlı olduğu anlamına gelmez; yine de indirdiğin dosyanın buradaki dosya olduğundan emin olmak için
          SHA-256 değerini karşılaştırabilirsin (aşağıda).
        </p>
      )}

      {windows && (
        <Help title="Windows" open={mine === 'windows'} testId="indir-help-windows">
          {downloads.signed.windows ? (
            <p data-testid="indir-signed-windows">
              Windows dosyası imzalı. Yeni bir sürüm ilk günlerinde yine de “Windows bilgisayarınızı korudu” derse
              <b> Daha fazla bilgi</b> › <b>Yine de çalıştır</b>.
            </p>
          ) : (
            <>
              <ol>
                <li>
                  Tarayıcı dosyanın “yaygın olarak indirilmediğini” söylerse indirilenler listesinde dosyanın yanındaki
                  <b> ⋯</b> menüsünden <b>Sakla</b>'yı seç (Edge'de ardından <b>Daha fazla göster</b> ›{' '}
                  <b>Yine de sakla</b>).
                </li>
                <li>
                  Dosyayı aç. Mavi “Windows bilgisayarınızı korudu” penceresinde önce <b>Daha fazla bilgi</b>'ye, sonra{' '}
                  <b>Yine de çalıştır</b>'a bas. Yayımcı “Bilinmeyen yayımcı” görünür; bu beklenen bir durum.
                </li>
                <li>Kurulum sihirbazını bitir. Uyarı her sürümde yalnız ilk açılışta çıkar.</li>
              </ol>
              <SmartScreenDrawing name={windows.name} />
            </>
          )}
          {windows.sha256 && (
            <>
              <p>
                Dosyanın gerçek olduğunu doğrulamak için PowerShell'i aç ve şunu yapıştır (dosyayı başka bir klasöre
                kaydettiysen yolu değiştir). <b>True</b> yazarsa dosya buradakiyle aynıdır:
              </p>
              <Command text={powershellCheck(windows.name, windows.sha256)} testId="indir-powershell" />
            </>
          )}
        </Help>
      )}

      {mac && (
        <Help title="macOS" open={mine === 'mac'} testId="indir-help-mac">
          {downloads.signed.mac ? (
            <p data-testid="indir-signed-mac">
              Mac dosyaları imzalı ve Apple tarafından onaylanmış (notarize). İlk açılışta yalnız “İnternetten
              indirildi, açmak istiyor musun?” sorusu çıkar: <b>Aç</b>.
            </p>
          ) : (
            <>
              <ol>
                <li>
                  <code>.dmg</code> dosyasını aç ve Trio'yu <b>Uygulamalar</b> klasörüne sürükle.
                </li>
                <li>
                  Trio'yu aç. “Apple, Trio'nun kötü amaçlı yazılım içermediğini doğrulayamadı” uyarısını{' '}
                  <b>Bitti</b> ile kapat.
                </li>
                <li>
                  <b>Sistem Ayarları</b> › <b>Gizlilik ve Güvenlik</b>'i aç, en aşağıdaki “Trio engellendi” satırının
                  yanındaki <b>Yine de Aç</b>'a bas, parolanı gir ve <b>Aç</b>'ı onayla.
                </li>
              </ol>
              <MacDrawing />
              <p className="indir-muted">
                macOS 14 (Sonoma) ve öncesinde Trio'ya Control tuşuyla tıklayıp <b>Aç</b> demek de yeter; macOS 15
                (Sequoia) ve sonrasında bu kısayol kalktı, yol yukarıdaki. “Trio hasarlı” derse Terminal'de{' '}
                <code>xattr -dr com.apple.quarantine /Applications/Trio.app</code> çalıştırıp yeniden aç.
              </p>
            </>
          )}
          {mac.sha256 && (
            <>
              <p>
                Doğrulamak için Terminal'e yapıştır; <b>OK</b> yazarsa dosya buradakiyle aynıdır:
              </p>
              <Command text={shellCheck(mac.platform, mac.name, mac.sha256)} testId="indir-shasum" />
            </>
          )}
        </Help>
      )}

      {linux && (
        <Help title="Linux" open={mine === 'linux'} testId="indir-help-linux">
          <p>AppImage kurulmaz, doğrudan çalışır. Önce çalıştırılabilir yap:</p>
          <Command text={`chmod +x "$(xdg-user-dir DOWNLOAD)/${linux.name}"`} testId="indir-chmod" />
          <p className="indir-muted">
            Açılmazsa FUSE 2 eksik olabilir: Ubuntu 24.04'te <code>sudo apt install libfuse2t64</code>, daha eskilerde{' '}
            <code>libfuse2</code>.
          </p>
          {linux.sha256 && (
            <>
              <p>
                Doğrulamak için; <b>OK</b> yazarsa dosya buradakiyle aynıdır:
              </p>
              <Command text={shellCheck('linux', linux.name, linux.sha256)} testId="indir-sha256sum" />
            </>
          )}
        </Help>
      )}
    </section>
  )
}

function Help({ title, open, testId, children }: { title: string; open: boolean; testId: string; children: ReactNode }) {
  return (
    <details className="indir-help" open={open} data-testid={testId}>
      <summary>{title}</summary>
      <div className="indir-help-body">{children}</div>
    </details>
  )
}

/** Drawn, not a screenshot: the two SmartScreen screens, the two clicks marked. */
function SmartScreenDrawing({ name }: { name: string }) {
  return (
    <figure className="indir-drawing" data-testid="indir-smartscreen">
      <div
        className="ss-row"
        role="img"
        aria-label="SmartScreen penceresi: önce Daha fazla bilgi bağlantısına, sonra Yine de çalıştır düğmesine basılır"
      >
        <div className="ss-dialog" aria-hidden="true">
          <p className="ss-title">Windows bilgisayarınızı korudu</p>
          <p className="ss-text">
            Microsoft Defender SmartScreen tanınmayan bir uygulamanın başlatılmasını engelledi. Bu uygulamayı
            çalıştırmak bilgisayarınızı riske atabilir.
          </p>
          <p className="ss-link ss-mark" data-step="1">
            Daha fazla bilgi
          </p>
          <div className="ss-buttons">
            <span className="ss-button">Çalıştırma</span>
          </div>
        </div>
        <div className="ss-dialog" aria-hidden="true">
          <p className="ss-title">Windows bilgisayarınızı korudu</p>
          <p className="ss-text">
            Uygulama: {name}
            <br />
            Yayımcı: Bilinmeyen yayımcı
          </p>
          <div className="ss-buttons">
            <span className="ss-button ss-mark" data-step="2">
              Yine de çalıştır
            </span>
            <span className="ss-button">Çalıştırma</span>
          </div>
        </div>
      </div>
      <figcaption className="indir-muted">Temsili çizim; Windows sürümüne göre yazılar biraz farklı olabilir.</figcaption>
    </figure>
  )
}

function MacDrawing() {
  return (
    <figure className="indir-drawing" data-testid="indir-mac-drawing">
      <div
        className="mac-panel"
        role="img"
        aria-label="Sistem Ayarları, Gizlilik ve Güvenlik: Trio engellendi satırının yanındaki Yine de Aç düğmesi"
      >
        <div className="mac-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <b>Gizlilik ve Güvenlik</b>
        </div>
        <div className="mac-body" aria-hidden="true">
          <p className="mac-heading">Güvenlik</p>
          <div className="mac-line">
            <span>“Trio”, Mac'inizi korumak için engellendi.</span>
            <span className="mac-button ss-mark" data-step="1">
              Yine de Aç
            </span>
          </div>
        </div>
      </div>
      <figcaption className="indir-muted">Temsili çizim.</figcaption>
    </figure>
  )
}

function DownloadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
