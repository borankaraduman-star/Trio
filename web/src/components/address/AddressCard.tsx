import { useCallback, useEffect, useState } from 'react'
import { ApiError, loadAuth, request } from '../../api'
import { formatLinkCode } from '../../lib/linkCode'
import { hostOf } from '../../lib/address'
import { ownerErrorMessage } from '../../lib/opsFormat'
import { ConfirmCodeDialog } from '../owner/ConfirmCodeDialog'

/** GET /api/owner/address (CONTRACT-V11-ADDRESS §4, §8, §9). */
export interface OwnerAddressView {
  public_url: string | null
  next_url: string | null
  request_origin: string | null
  reachable: null | { ok: boolean; same_server: boolean; at: string; detail?: string }
  sessions: { total: number; canonical: number; other: number; unknown: number; moved: number }
  other_origins: { origin: string; sessions: number }[]
  prepared: { sessions: number; total: number }
  bulk: { live: number; expires_at: string | null }
  recovery: { configured: boolean; used_at: string | null; uses_this_boot: number; max_per_boot: number }
  safe_to_retire: boolean
}

interface BulkCode {
  user: { id: number; name: string }
  code: string
  url: string | null
}

/** "Ali — ABCDE-FGHJK — <link>" lines to paste into a chat one by one. */
export function bulkCodesText(codes: BulkCode[]): string {
  return codes.map((c) => `${c.user.name} — ${formatLinkCode(c.code)}${c.url ? ` — ${c.url}` : ''}`).join('\n')
}

function stateLine(view: OwnerAddressView): string {
  if (!view.public_url) return 'TRIO_PUBLIC_URL ayarlı değil: Trio hangi adresten açılırsa onu kullanıyor.'
  const host = hostOf(view.public_url)
  const reach = view.reachable
  if (!reach) return `Kalıcı adres: ${host}`
  if (reach.ok && reach.same_server) return `Kalıcı adres: ${host} — ulaşılıyor, bu sunucu.`
  if (reach.ok) return `Kalıcı adres: ${host} — cevap veren başka bir Trio sunucusu!`
  return `Kalıcı adres: ${host} — şu an ulaşılamıyor (${reach.detail ?? 'hata'}).`
}

/** Ayarlar › Yönetim › Adres: where the server lives, where its devices are, the way back in. */
export function AddressCard() {
  const token = loadAuth()?.token ?? null
  const [view, setView] = useState<OwnerAddressView | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [codes, setCodes] = useState<{ list: BulkCode[]; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      setView(await request<OwnerAddressView>('/api/owner/address', { token }))
    } catch {
      // Shown as "Yükleniyor…" until it works.
    }
  }, [token])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const makeCodes = async (confirm: string) => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const made = await request<{ codes: BulkCode[]; expires_at: string }>('/api/owner/bulk-codes', {
        method: 'POST',
        token,
        body: { confirm_code: confirm },
      })
      setCodes({ list: made.codes, expiresAt: made.expires_at })
      setAsking(false)
      void refresh()
    } catch (failure) {
      setError(failure instanceof ApiError ? ownerErrorMessage(failure.code, failure.retryAfter) : ownerErrorMessage('UNKNOWN'))
    } finally {
      setBusy(false)
    }
  }

  const cancelCodes = async () => {
    if (!token) return
    try {
      await request('/api/owner/bulk-codes', { method: 'DELETE', token })
      setCodes(null)
      void refresh()
    } catch {
      // Stays as it was; the list is refreshed.
    }
  }

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
    } catch {
      setCopied(null)
    }
  }

  if (!view) {
    return (
      <div className="ops-card address-card" data-testid="owner-address">
        <div className="ops-card-head">
          <h4>Adres</h4>
        </div>
        <p className="settings-hint">Yükleniyor…</p>
      </div>
    )
  }

  const { sessions } = view
  const here = view.request_origin
  // On the announced address, or in after a lock-out: what has to be done again.
  const afterChange = Boolean((view.next_url && here === view.next_url) || view.recovery.used_at)
  return (
    <div className="ops-card address-card" data-testid="owner-address" data-safe={view.safe_to_retire ? 'yes' : 'no'}>
      <div className="ops-card-head">
        <h4>Adres</h4>
      </div>
      <p data-testid="owner-address-state">{stateLine(view)}</p>
      {view.next_url && (
        <p data-testid="owner-address-next">
          Duyurulan yeni adres: <b>{hostOf(view.next_url)}</b> — {view.prepared.sessions}/{view.prepared.total} oturum
          taşınma kodunu aldı.
        </p>
      )}
      {view.public_url && (
        <p data-testid="owner-address-sessions">
          Oturumlar: {sessions.canonical} yeni adreste, {sessions.other} eski adreste
          {sessions.unknown > 0 ? `, ${sessions.unknown} henüz görülmedi` : ''}; {sessions.moved} cihaz taşındı.
        </p>
      )}
      {view.other_origins.length > 0 && view.public_url && (
        <ul className="address-origins">
          {view.other_origins.map((o) => (
            <li key={o.origin}>
              {hostOf(o.origin)}: {o.sessions} oturum
            </li>
          ))}
        </ul>
      )}
      {view.public_url && (
        <p className={view.safe_to_retire ? 'address-safe' : 'settings-hint'} data-testid="owner-address-retire">
          {view.safe_to_retire
            ? 'Eski adresi kullanan oturum kalmadı: eski adresi bırakmak güvenli.'
            : 'Eski adresi henüz kaldırma: hâlâ oradan giren cihazlar var ya da yeni adres doğrulanmadı.'}
        </p>
      )}

      {afterChange && (
        <div className="address-checklist" data-testid="owner-address-checklist">
          <p>
            <b>Adres değişti: yapılacaklar</b>
          </p>
          <ol>
            <li>Herkese giriş kodu üret (aşağıda) ve her birine kendi kodunu gönder.</li>
            <li>Davet bağlantısını ve cihaz QR’larını yeniden paylaş: eskileri eski adrese gidiyor.</li>
            <li>Bildirim iznini her cihazda yeni adreste bir kez daha ver.</li>
            <li>Ana ekrana eklenmiş Trio’yu sil, yeni adresten yeniden ekle.</li>
            <li>Railway’de TRIO_PUBLIC_URL’i yeni adrese ayarla; TRIO_NEXT_URL ve TRIO_RECOVERY_CODE’u sil.</li>
          </ol>
        </div>
      )}

      <div className="address-bulk" data-testid="owner-bulk">
        <p className="settings-hint">
          Herkese giriş kodu: diğer her kişiye 24 saat geçerli, bir kez kullanılan bir cihaz kodu. Adres değiştiyse ve
          kimse giriş yapamıyorsa bunu kullan.
          {view.bulk.live > 0 ? ` Şu an ${view.bulk.live} kod kullanılmayı bekliyor.` : ''}
        </p>
        <div className="ops-actions">
          <button type="button" className="secondary" data-testid="owner-bulk-make" onClick={() => setAsking(true)}>
            Herkese giriş kodu üret
          </button>
          {view.bulk.live > 0 && (
            <button type="button" className="link" data-testid="owner-bulk-cancel" onClick={() => void cancelCodes()}>
              Bekleyen kodları iptal et
            </button>
          )}
        </div>
        {codes && (
          <div className="address-bulk-list" data-testid="owner-bulk-list">
            <p className="settings-hint">
              Bu kodlar yalnızca şimdi gösteriliyor. Her kişiye kendi satırını özelden gönder.
            </p>
            <ul>
              {codes.list.map((c) => (
                <li key={c.user.id} data-testid="owner-bulk-row">
                  <span className="address-bulk-name">{c.user.name}</span>
                  <code className="link-code">{formatLinkCode(c.code)}</code>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void copy(String(c.user.id), bulkCodesText([c]))}
                  >
                    {copied === String(c.user.id) ? 'Kopyalandı' : 'Kopyala'}
                  </button>
                </li>
              ))}
            </ul>
            {codes.list.length === 0 && <p className="settings-hint">Senden başka kimse yok.</p>}
            <button
              type="button"
              className="link"
              data-testid="owner-bulk-copy-all"
              onClick={() => void copy('all', bulkCodesText(codes.list))}
            >
              {copied === 'all' ? 'Tümü kopyalandı' : 'Tümünü kopyala'}
            </button>
          </div>
        )}
      </div>

      <p className="settings-hint" data-testid="owner-recovery">
        {view.recovery.configured
          ? view.recovery.used_at
            ? 'TRIO_RECOVERY_CODE ayarlı ve kullanıldı: işin bittiyse Railway’den sil.'
            : 'TRIO_RECOVERY_CODE ayarlı: bütün cihazların giderse bununla girebilirsin. Gerek kalmayınca sil.'
          : 'Kilitlenme sigortası: Railway › Variables’a TRIO_RECOVERY_CODE (en az 24 karakter, rastgele) eklersen, hiçbir cihazın kalmasa da “Zaten hesabım var” ile girebilirsin.'}
      </p>

      {asking && (
        <ConfirmCodeDialog
          title="Herkese giriş kodu üret"
          body="Senden başka herkes için 24 saat geçerli bir cihaz kodu üretilir; önceki bekleyen kodlar geçersiz olur. Onaylamak için davet kodunu yaz."
          action="Kodları üret"
          busy={busy}
          error={error}
          onConfirm={(code) => void makeCodes(code)}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  )
}
