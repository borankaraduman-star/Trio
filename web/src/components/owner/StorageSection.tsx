import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, loadAuth } from '../../api'
import { formatSize } from '../../lib/attachments'
import { usageRatio, usageText } from '../../lib/opsFormat'
import { opsApi, type StoredFile, type StoragePage } from '../../owner/opsApi'
import { opsStore } from '../../owner/opsStore'

const PAGE = 50

export function UsageBar({ used, quota, testId }: { used: number; quota: number; testId?: string }) {
  const ratio = usageRatio(used, quota)
  const level = ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : 'low'
  return (
    <div
      className={`ops-bar ${level}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={quota}
      aria-valuenow={used}
      aria-label="Depolama kullanımı"
      data-testid={testId}
      data-used={used}
    >
      <span style={{ width: `${Math.max(ratio > 0 ? 1 : 0, ratio * 100)}%` }} />
    </div>
  )
}

function FileRow({
  file,
  onDelete,
}: {
  file: StoredFile
  onDelete: (file: StoredFile) => Promise<void>
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <li className="ops-file" data-testid="storage-file" data-id={file.id}>
      <span className="ops-file-text">
        <a href={file.url} target="_blank" rel="noopener noreferrer" className="ops-file-name" title={file.filename}>
          {file.filename}
        </a>
        <span className="ops-file-meta">
          {formatSize(file.size)}
          {file.message ? (file.message.excerpt ? ` · “${file.message.excerpt}”` : ' · mesajda') : ' · mesaja eklenmemiş'}
        </span>
      </span>
      {asking ? (
        <span className="ops-file-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => setAsking(false)}>
            Vazgeç
          </button>
          <button
            type="button"
            className="danger"
            data-testid="storage-delete-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onDelete(file)
              } finally {
                setBusy(false)
                setAsking(false)
              }
            }}
          >
            {busy ? 'Siliniyor…' : 'Sil'}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="ghost danger-text"
          data-testid="storage-delete"
          aria-label={`Sil: ${file.filename}`}
          onClick={() => setAsking(true)}
        >
          Sil
        </button>
      )}
    </li>
  )
}

/** Ayarlar › Depolama: how much of my quota is used, my files largest first, delete. */
export function StorageSection() {
  const token = loadAuth()?.token ?? null
  const ops = useSyncExternalStore(opsStore.subscribe, opsStore.getSnapshot)
  const [page, setPage] = useState<StoragePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    try {
      setPage(await opsApi.myStorage(token, 0, PAGE))
      setError(null)
    } catch {
      setError('Depolama bilgisi alınamadı.')
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const more = async () => {
    if (!token || !page) return
    setLoadingMore(true)
    try {
      const next = await opsApi.myStorage(token, page.attachments.length, PAGE)
      setPage({ ...next, attachments: [...page.attachments, ...next.attachments] })
    } catch {
      setError('Liste yüklenemedi.')
    } finally {
      setLoadingMore(false)
    }
  }

  const remove = async (file: StoredFile) => {
    if (!token) return
    try {
      const { storage } = await opsApi.deleteAttachment(token, file.id)
      setPage((current) =>
        current
          ? { ...current, ...storage, attachments: current.attachments.filter((a) => a.id !== file.id) }
          : current,
      )
      setError(null)
      if (opsStore.getSnapshot().isOwner) void opsStore.refresh()
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === 'NOT_FOUND'
          ? 'Bu dosya zaten silinmiş.'
          : failure instanceof ApiError && failure.code === 'RATE_LIMITED'
            ? 'Çok hızlı siliyorsun; bir dakika sonra yeniden dene.'
            : 'Dosya silinemedi.',
      )
      if (failure instanceof ApiError && failure.code === 'NOT_FOUND') void load()
    }
  }

  return (
    <section className="settings-section ops-section" aria-labelledby="settings-storage" data-testid="storage-section">
      <h3 id="settings-storage">Depolama</h3>
      {page ? (
        <>
          <div className="ops-usage">
            <span data-testid="storage-usage">{usageText(page.used_bytes, page.quota_bytes)}</span>
            <span className="settings-hint">{page.file_count} dosya</span>
          </div>
          <UsageBar used={page.used_bytes} quota={page.quota_bytes} testId="storage-bar" />
          <p className="settings-hint">
            Kota yüklediğin tüm dosyaların toplamıdır. Bir dosyayı silersen herkesten kalkar, mesajda “dosya silindi”
            yazar ve yeri kotana geri döner.
          </p>
          {page.attachments.length === 0 ? (
            <p className="settings-hint" data-testid="storage-empty">
              Yüklediğin dosya yok.
            </p>
          ) : (
            <ul className="ops-files" aria-label="Dosyaların, büyükten küçüğe">
              {page.attachments.map((file) => (
                <FileRow key={file.id} file={file} onDelete={remove} />
              ))}
            </ul>
          )}
          {page.has_more && (
            <button type="button" className="ghost" disabled={loadingMore} onClick={() => void more()}>
              {loadingMore ? 'Yükleniyor…' : 'Daha fazla göster'}
            </button>
          )}
        </>
      ) : (
        !error && <p className="settings-hint">Yükleniyor…</p>
      )}
      {error && (
        <p className="ops-error" role="alert">
          {error}
        </p>
      )}
      {ops.isOwner && ops.overview && (
        <div className="ops-people-usage" data-testid="storage-per-user">
          <h4>Kişilerin kullanımı</h4>
          <ul>
            {ops.overview.users
              .filter((user) => !user.removed)
              .map((user) => (
                <li key={user.id}>
                  <span className="ops-person-name">{user.name}</span>
                  <span className="settings-hint">
                    {usageText(user.stored_bytes, ops.overview!.storage.user_quota_bytes)} · {user.file_count} dosya
                  </span>
                  <UsageBar used={user.stored_bytes} quota={ops.overview!.storage.user_quota_bytes} />
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  )
}
