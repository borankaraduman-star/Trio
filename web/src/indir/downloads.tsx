/**
 * The download parts of /indir (CONTRACT-V6-DOWNLOAD): the primary button, the
 * phone card, every file with its SHA-256, and the honest help for the
 * install warning. Behaviour unchanged from 0.5; only the look moved.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  family,
  formatSize,
  PLATFORM_LABEL,
  PLATFORM_SHORT,
  powershellCheck,
  shellCheck,
  type DownloadFile,
  type Downloads,
  type Visitor,
} from './platform'

export function PrimaryButton({ file, version, date }: { file: DownloadFile; version: string | null; date: string | null }) {
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

export function PhoneCard() {
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

export function FileRow({ file, primary }: { file: DownloadFile; primary: boolean }) {
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

export function CopyButton({ text, label }: { text: string; label: string }) {
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

export function WarningHelp({ downloads, visitor }: { downloads: Downloads; visitor: Visitor }) {
  const byFamily = (name: 'windows' | 'mac' | 'linux') => downloads.files.filter((f) => family(f.platform) === name)
  const windows = byFamily('windows')[0]
  const macs = byFamily('mac')
  const mac = macs.find((f) => f.platform === visitor) ?? macs[0]
  const linux = byFamily('linux')[0]
  const mine = visitor === 'phone' || visitor === 'unknown' ? null : family(visitor)
  const unsignedSomewhere = (windows && !downloads.signed.windows) || (mac && !downloads.signed.mac)

  return (
    <section className="indir-help-section" aria-labelledby="indir-help-title" data-testid="indir-help">
      <h3 id="indir-help-title">Kurulumda uyarı çıkarsa</h3>
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

export function DownloadIcon() {
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
