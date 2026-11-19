import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, loadAuth } from '../../api'
import { formatSize } from '../../lib/attachments'
import { formatLinkCode } from '../../lib/linkCode'
import {
  backupStale,
  formatCount,
  formatUptime,
  lastBackupLine,
  ownerErrorMessage,
  relativeTime,
  turnLabel,
} from '../../lib/opsFormat'
import { dataAgeLine, freeSeatsLine, NOT_PERSISTENT_TEXT } from '../../lib/persistence'
import { opsApi, type ClientErrorRow, type OwnerUser } from '../../owner/opsApi'
import { opsStore } from '../../owner/opsStore'
import { ConfirmCodeDialog } from './ConfirmCodeDialog'
import { UsageBar } from './StorageSection'

type ActionKind = 'revoke' | 'remove' | 'link'

const ACTIONS: Record<ActionKind, { label: string; title: (name: string) => string; body: string; action: string; danger: boolean }> = {
  revoke: {
    label: 'Oturumları kapat',
    title: (name) => `${name}: her yerde oturumu kapat`,
    body: 'Bütün cihazlarından çıkış yapılır; hesabı ve mesajları durur. Geri dönmek için ona bir cihaz kodu verebilirsin.',
    action: 'Oturumları kapat',
    danger: true,
  },
  link: {
    label: 'Cihaz kodu',
    title: (name) => `${name} için cihaz kodu`,
    body: 'Tek kullanımlık, 10 dakika geçerli bir kod. Bütün cihazlarını kaybetmiş bir arkadaşın “Zaten hesabım var” ile bu kodla geri girer. Kodu yalnızca ona ver: kodu bilen onun hesabına girer.',
    action: 'Kod oluştur',
    danger: false,
  },
  remove: {
    label: 'Çıkar',
    title: (name) => `${name} sunucudan çıkarılsın mı?`,
    body: 'Oturumları kapanır, yeri ve adı boşa çıkar. Mesajları onun adıyla kalır. Bu geri alınamaz.',
    action: 'Çıkar',
    danger: true,
  },
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function PersonRow({ user, now, onAction }: { user: OwnerUser; now: number; onAction: (kind: ActionKind, user: OwnerUser) => void }) {
  const seen = user.online
    ? user.connections > 1
      ? `çevrimiçi · ${user.connections} bağlantı`
      : 'çevrimiçi'
    : user.last_seen_at
      ? `son görülme ${relativeTime(Date.parse(user.last_seen_at), now)}`
      : 'çevrimdışı'
  return (
    <li className="ops-person" data-testid="owner-user" data-name={user.name}>
      <span className={user.online ? 'dot online' : 'dot'} aria-hidden="true" />
      <span className="ops-person-text">
        <span className="ops-person-name">
          {user.name}
          {user.is_owner && <span className="ops-tag">sahip</span>}
        </span>
        <span className="settings-hint">
          {seen} · {formatSize(user.stored_bytes)} · {user.file_count} dosya
        </span>
      </span>
      {!user.is_owner && (
        <span className="ops-person-actions">
          {(['revoke', 'link', 'remove'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={kind === 'remove' ? 'ghost danger-text' : 'ghost'}
              data-testid={`owner-${kind}`}
              onClick={() => onAction(kind, user)}
            >
              {ACTIONS[kind].label}
            </button>
          ))}
        </span>
      )}
    </li>
  )
}

function ErrorList({ token }: { token: string }) {
  const [rows, setRows] = useState<ClientErrorRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const now = useNow(60_000)
  const load = useCallback(async () => {
    try {
      setRows((await opsApi.errors(token)).errors)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [token])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div className="ops-card ops-errors" data-testid="owner-errors">
      <div className="ops-card-head">
        <h4>Hata kayıtları</h4>
        <span className="ops-card-tools">
          <button type="button" className="ghost" onClick={() => void load()}>
            Yenile
          </button>
          <button
            type="button"
            className="ghost"
            data-testid="owner-errors-clear"
            disabled={!rows || rows.length === 0}
            onClick={async () => {
              try {
                await opsApi.clearErrors(token)
                setRows([])
              } catch {
                setFailed(true)
              }
            }}
          >
            Temizle
          </button>
        </span>
      </div>
      {failed && <p className="ops-error">Hata kayıtları alınamadı.</p>}
      {rows && rows.length === 0 && <p className="settings-hint">Kayıtlı hata yok.</p>}
      {rows && rows.length > 0 && (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="ops-error-row" data-testid="owner-error">
              <details>
                <summary>
                  <span className="ops-error-message">{row.message}</span>
                  <span className="settings-hint">
                    ×{row.count} · {relativeTime(Date.parse(row.last_at), now)} · {row.versions.join(', ')}
                    {row.user ? ` · ${row.user.name}` : ''}
                    {row.browser ? ` · ${row.browser}` : ''}
                  </span>
                </summary>
                {row.stack && <pre className="ops-stack">{row.stack}</pre>}
                {row.context && <p className="settings-hint">Sayfa: {row.context}</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Ayarlar › Yönetim: only rendered for the owner. */
export function OwnerSection() {
  const token = loadAuth()?.token ?? null
  const { overview } = useSyncExternalStore(opsStore.subscribe, opsStore.getSnapshot)
  const now = useNow(30_000)
  const [pending, setPending] = useState<{ kind: ActionKind; user: OwnerUser } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [linkCode, setLinkCode] = useState<{ name: string; code: string; expiresAt: string } | null>(null)
  const [backupState, setBackupState] = useState<'idle' | 'starting' | 'running' | 'done' | 'error'>('idle')
  const [backupError, setBackupError] = useState<string | null>(null)
  const backupFrom = useRef<string | null>(null)

  useEffect(() => {
    void opsStore.refresh()
    const timer = setInterval(() => void opsStore.refresh(), 15_000)
    return () => clearInterval(timer)
  }, [])

  // While a download runs, follow its progress and notice when it is recorded.
  useEffect(() => {
    if (backupState !== 'running' && backupState !== 'starting') return
    const started = Date.now()
    const timer = setInterval(() => {
      void opsStore.refresh().then(() => {
        const backup = opsStore.getSnapshot().overview?.backup
        if (backup?.last && backup.last.at !== backupFrom.current) setBackupState('done')
        else if (backup?.in_progress) setBackupState('running')
        else if (Date.now() - started > 15 * 60_000) setBackupState('idle')
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [backupState])

  const run = async (code: string) => {
    if (!token || !pending) return
    const { kind, user } = pending
    setBusy(true)
    setActionError(null)
    try {
      if (kind === 'revoke') {
        const result = await opsApi.revokeTokens(token, user.id, code)
        setNotice(`${user.name}: ${result.sessions_ended} oturum kapatıldı.`)
      } else if (kind === 'remove') {
        await opsApi.removeUser(token, user.id, code)
        setNotice(`${user.name} sunucudan çıkarıldı.`)
      } else {
        const result = await opsApi.linkCode(token, user.id, code)
        setLinkCode({ name: user.name, code: result.code, expiresAt: result.expires_at })
        setNotice(null)
      }
      setPending(null)
      void opsStore.refresh()
    } catch (failure) {
      setActionError(
        failure instanceof ApiError ? ownerErrorMessage(failure.code, failure.retryAfter) : ownerErrorMessage('UNKNOWN'),
      )
    } finally {
      setBusy(false)
    }
  }

  const downloadBackup = async () => {
    if (!token) return
    setBackupError(null)
    setBackupState('starting')
    backupFrom.current = overview?.backup.last?.at ?? null
    try {
      const { url } = await opsApi.backupTicket(token)
      // A plain browser download (no bearer header possible): the single-use ticket is the key.
      const link = document.createElement('a')
      link.href = url
      link.download = ''
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (failure) {
      setBackupState('error')
      setBackupError(failure instanceof ApiError ? ownerErrorMessage(failure.code) : ownerErrorMessage('UNKNOWN'))
    }
  }

  if (!overview) {
    return (
      <section className="settings-section ops-section" aria-labelledby="settings-owner" data-testid="owner-section">
        <h3 id="settings-owner">Yönetim</h3>
        <p className="settings-hint">Yükleniyor…</p>
      </section>
    )
  }

  const { storage, server, turn, backup } = overview
  const active = overview.users.filter((user) => !user.removed)
  const removed = overview.users.filter((user) => user.removed)
  const progress = backup.in_progress
  const stale = backupStale(backup.last, now)
  const diskUsed = storage.disk_total_bytes - storage.disk_free_bytes
  const freeSeats = freeSeatsLine(overview.limits.max_users, active.length)
  const ownerUnset = server.owner_rule !== 'TRIO_OWNER'
  const dataAge = dataAgeLine(server.data_since, server.boot_count, now)

  return (
    <section className="settings-section ops-section" aria-labelledby="settings-owner" data-testid="owner-section">
      <h3 id="settings-owner">Yönetim</h3>
      <p className="settings-hint">Bu bölümü yalnızca sen görüyorsun: sunucunun sahibi sensin.</p>

      {server.persistent === false && (
        <div className="ops-card ops-warnings danger-card" data-testid="owner-volume-steps">
          <div className="ops-card-head">
            <h4>Kalıcı disk yok</h4>
          </div>
          <p className="ops-warn">{NOT_PERSISTENT_TEXT}</p>
          <ol>
            <li>Önce buradan bir yedek indir (aşağıda).</li>
            <li>
              Railway’de Trio servisini aç › <b>Settings › Volumes › New Volume</b>.
            </li>
            <li>
              Bağlama yolu (mount path) olarak <code>/data</code> yaz ve kaydet.
            </li>
            <li>Servis yeniden başlar; bu kırmızı uyarı kaybolmalı.</li>
            <li>Veriler boş gelirse yedeği geri yükle (docs/yedek.md).</li>
          </ol>
        </div>
      )}

      {(ownerUnset || freeSeats) && (
        <div className="ops-card ops-warnings" data-testid="owner-warnings">
          <div className="ops-card-head">
            <h4>Dikkat</h4>
          </div>
          <ul>
            {ownerUnset && (
              <li data-testid="owner-warning-owner">
                TRIO_OWNER ayarlı değil: sahip = ilk katılan kişi. Railway’de bu değişkene kendi adını yazarsan sahiplik
                sabitlenir.
              </li>
            )}
            {freeSeats && (
              <li data-testid="owner-warning-seats">
                {freeSeats}: davet kodunu bilen herkes katılabilir. Gerekmiyorsa TRIO_MAX_USERS değerini kişi sayısına
                indir.
              </li>
            )}
          </ul>
        </div>
      )}

      <div className={`ops-card ops-backup${stale ? ' stale' : ''}`} data-testid="owner-backup">
        <div className="ops-card-head">
          <h4>Yedek</h4>
        </div>
        <p data-testid="owner-last-backup" className={stale ? 'ops-warn' : undefined}>
          {lastBackupLine(backup.last, now)}
        </p>
        {stale && <p className="settings-hint">Yedeğin 14 günden eski (ya da hiç yok). Telefonuna bir yedek indir.</p>}
        {progress && (
          <div className="ops-progress" data-testid="owner-backup-progress">
            <UsageBar used={progress.sent} quota={progress.total} />
            <span className="settings-hint">
              {formatSize(progress.sent)} / {formatSize(progress.total)}
            </span>
          </div>
        )}
        <button
          type="button"
          className="primary"
          data-testid="owner-backup-download"
          disabled={backupState === 'starting' || progress !== null}
          onClick={() => void downloadBackup()}
        >
          {progress || backupState === 'starting' ? 'İndiriliyor…' : 'Yedeği indir'}
        </button>
        {backupState === 'done' && (
          <p className="ops-ok" role="status" data-testid="owner-backup-done">
            Yedek indirildi. Dosyayı güvenli bir yerde sakla: herkesin mesajları ve dosyaları içinde.
          </p>
        )}
        {backupError && (
          <p className="ops-error" role="alert">
            {backupError}
          </p>
        )}
        <p className="settings-hint">
          Tek bir .tar dosyası: veritabanının tutarlı bir kopyası ve bütün yüklenen dosyalar ({formatSize(storage.uploads_bytes + storage.db_bytes)}).
          Geri yükleme adımları docs/yedek.md içinde.
        </p>
      </div>

      <div className="ops-grid">
        <div className="ops-card" data-testid="owner-people">
          <div className="ops-card-head">
            <h4>Kişiler</h4>
            <span className="settings-hint">
              {active.length} / {overview.limits.max_users}
            </span>
          </div>
          <ul className="ops-people">
            {active.map((user) => (
              <PersonRow
                key={user.id}
                user={user}
                now={now}
                onAction={(kind, target) => {
                  setActionError(null)
                  setPending({ kind, user: target })
                }}
              />
            ))}
          </ul>
          {removed.length > 0 && (
            <p className="settings-hint">Çıkarılanlar: {removed.map((user) => user.name).join(', ')}</p>
          )}
          {notice && (
            <p className="ops-ok" role="status" data-testid="owner-notice">
              {notice}
            </p>
          )}
          {linkCode && (
            <div className="ops-link-code" data-testid="owner-link-code">
              <span className="settings-hint">{linkCode.name} için cihaz kodu (tek kullanımlık, 10 dakika):</span>
              <code>{formatLinkCode(linkCode.code)}</code>
            </div>
          )}
        </div>

        <div className="ops-card" data-testid="owner-storage">
          <div className="ops-card-head">
            <h4>Depolama</h4>
          </div>
          <dl className="ops-facts">
            <dt>Yüklenen dosyalar</dt>
            <dd>
              {formatSize(storage.uploads_bytes)} · {formatCount(storage.upload_files)} dosya
            </dd>
            <dt>Veritabanı</dt>
            <dd>{formatSize(storage.db_bytes)}</dd>
            <dt>Disk</dt>
            <dd>
              {formatSize(storage.disk_free_bytes)} boş / {formatSize(storage.disk_total_bytes)}
            </dd>
          </dl>
          <UsageBar used={diskUsed} quota={storage.disk_total_bytes} testId="owner-disk-bar" />
          <p className="settings-hint">
            Kişi başı kota {formatSize(storage.user_quota_bytes)}, en büyük dosya {formatSize(storage.max_upload_bytes)},
            diskte ayrılan pay {formatSize(storage.disk_reserve_bytes)}.
          </p>
        </div>

        <div className="ops-card" data-testid="owner-server">
          <div className="ops-card-head">
            <h4>Sunucu</h4>
          </div>
          <dl className="ops-facts">
            <dt>Sürüm</dt>
            <dd>{server.version}</dd>
            <dt>Açık kalma</dt>
            <dd>{formatUptime(server.uptime_seconds)}</dd>
            {dataAge && (
              <>
                <dt>Veri</dt>
                <dd data-testid="owner-data-age">{dataAge.replace(/^Veri: /, '')}</dd>
              </>
            )}
            <dt>Mesajlar</dt>
            <dd>{formatCount(overview.counts.messages)}</dd>
            <dt>Python</dt>
            <dd>{server.python}</dd>
          </dl>
        </div>

        <div className="ops-card" data-testid="owner-turn">
          <div className="ops-card-head">
            <h4>TURN durumu</h4>
          </div>
          <p data-testid="owner-turn-provider">{turnLabel(turn.provider)}</p>
          {turn.provider === 'cloudflare' && (
            <p className="settings-hint">
              {turn.last_call
                ? turn.last_call.ok
                  ? `Son istek başarılı (${relativeTime(Date.parse(turn.last_call.at), now)}).`
                  : `Son istek başarısız (${relativeTime(Date.parse(turn.last_call.at), now)}): ${turn.last_call.detail ?? 'hata'}`
                : 'Bu açılıştan beri kimse sesli kanala girmedi; henüz istek yapılmadı.'}
            </p>
          )}
          {turn.provider === 'none' && (
            <p className="settings-hint">Sıkı NAT arkasındaki iki kişi birbirini duyamayabilir.</p>
          )}
        </div>
      </div>

      {token && <ErrorList token={token} />}

      {pending && (
        <ConfirmCodeDialog
          title={ACTIONS[pending.kind].title(pending.user.name)}
          body={ACTIONS[pending.kind].body}
          action={ACTIONS[pending.kind].action}
          danger={ACTIONS[pending.kind].danger}
          busy={busy}
          error={actionError}
          onConfirm={(code) => void run(code)}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  )
}
