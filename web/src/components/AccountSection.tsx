import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type LinkCode } from '../api'
import { formatCountdown, formatLinkCode, secondsLeft } from '../lib/linkCode'

export interface AccountProps {
  name: string
  createLinkCode: () => Promise<LinkCode>
  /** Make a code as soon as the section opens (from the sign-out dialog). */
  createAtOnce?: boolean
  /** `<origin>/#davet=<code>` when this device joined with the invite code, else null. */
  inviteLink: string | null
}

function linkCodeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'TOO_MANY_LINK_CODES') {
      return 'Henüz kullanılmamış 5 kodun var. Birini kullan ya da süreleri dolana kadar (en çok 10 dakika) bekle.'
    }
    if (error.status === 0 || error.status >= 500) return 'Sunucuya ulaşılamadı, kod oluşturulamadı.'
  }
  return 'Kod oluşturulamadı.'
}

/** Settings › Hesap: who is signed in here, "add a device", sign out. */
export function AccountSection({ account, onSignOut }: { account: AccountProps; onSignOut: () => void }) {
  const { createLinkCode, createAtOnce } = account
  const [code, setCode] = useState<LinkCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const inviteField = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const codeText = useRef<HTMLElement>(null)
  const started = useRef(false)
  const section = useRef<HTMLElement>(null)

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const next = await createLinkCode()
      setNow(Date.now())
      setCode(next)
    } catch (failure) {
      setError(linkCodeError(failure))
    } finally {
      setBusy(false)
    }
  }, [createLinkCode])

  useEffect(() => {
    if (createAtOnce && !started.current) {
      started.current = true
      section.current?.scrollIntoView({ block: 'nearest' })
      void create()
    }
  }, [createAtOnce, create])

  const left = code ? secondsLeft(code.expiresAtMs, now) : 0
  const live = code !== null && left > 0

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])

  const copy = async () => {
    if (!code) return
    const text = formatLinkCode(code.code)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // No clipboard (plain http, or denied): select the code so it can be copied by hand.
      const element = codeText.current
      const selection = window.getSelection()
      if (element && selection) {
        const range = document.createRange()
        range.selectNodeContents(element)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  const copyInvite = async () => {
    const link = account.inviteLink
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setLinkCopied(true)
    } catch {
      inviteField.current?.select()
    }
  }

  return (
    <section ref={section} className="settings-section account-section" aria-labelledby="settings-account" data-testid="settings-account">
      <h3 id="settings-account">Hesap</h3>
      <p className="account-who">
        Bu cihazda <strong>{account.name}</strong> olarak giriş yaptın.
      </p>

      <div className="settings-field">
        <span className="settings-label">Cihaz ekle</span>
        <p className="settings-hint">
          Telefonunda, başka bir tarayıcıda ya da masaüstü uygulamasında da aynı hesapla girmek için bir cihaz kodu
          oluştur. Kod 10 dakika geçerlidir ve bir kez kullanılır.
        </p>

        {code && live && (
          <div className="link-code-card" data-testid="link-code-card">
            <div className="link-code-row">
              <code ref={codeText} className="link-code" data-testid="link-code" aria-label="Cihaz kodu">
                {formatLinkCode(code.code)}
              </code>
              <button type="button" className="ghost" data-testid="link-code-copy" onClick={() => void copy()}>
                {copied ? 'Kopyalandı' : 'Kopyala'}
              </button>
            </div>
            <p className="link-code-expiry">
              Kalan süre: <strong data-testid="link-code-countdown">{formatCountdown(left)}</strong>
            </p>
            <p className="link-code-help">
              Diğer cihazda giriş ekranında <strong>“Zaten hesabım var”</strong> seçip bu kodu yaz.
            </p>
          </div>
        )}
        {code && !live && (
          <p className="settings-hint link-code-expired" data-testid="link-code-expired">
            Kodun süresi doldu; yenisini oluşturabilirsin.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert" data-testid="link-code-error">
            {error}
          </p>
        )}
        <div className="account-actions">
          <button
            type="button"
            className={live ? 'ghost' : 'primary'}
            data-testid="settings-add-device"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Oluşturuluyor…' : live ? 'Yeni kod oluştur' : 'Cihaz kodu oluştur'}
          </button>
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-label" id="invite-link-label">
          Davet bağlantısı
        </span>
        {account.inviteLink ? (
          <>
            <div className="invite-link-row">
              <input
                ref={inviteField}
                readOnly
                value={account.inviteLink}
                data-testid="invite-link"
                aria-labelledby="invite-link-label"
                onFocus={(event) => event.target.select()}
              />
              <button type="button" className="ghost" data-testid="invite-link-copy" onClick={() => void copyInvite()}>
                {linkCopied ? 'Kopyalandı' : 'Kopyala'}
              </button>
            </div>
            <p className="settings-hint">
              Bağlantıya sahip olan herkes, sunucunun kişi sınırı dolana kadar yeni hesap açıp katılabilir; yalnızca
              güvendiğin kişilere gönder.
            </p>
          </>
        ) : (
          <p className="settings-hint" data-testid="invite-link-unknown">
            Davet kodu bu cihazda kayıtlı değil (cihaz koduyla ya da bu özellik gelmeden önce girilmiş). Bağlantıyı,
            davet koduyla katılmış bir cihazından kopyalayabilirsin.
          </p>
        )}
      </div>

      <div className="settings-field">
        <span className="settings-label">Çıkış</span>
        <div className="account-actions">
          <button type="button" className="ghost danger-text" data-testid="settings-sign-out" onClick={onSignOut}>
            Bu cihazdan çıkış yap…
          </button>
        </div>
      </div>
    </section>
  )
}
