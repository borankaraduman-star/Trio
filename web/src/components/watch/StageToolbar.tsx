import { useState } from 'react'
import type { VoiceSnapshot } from '../../voice'
import { markTipSeen, sharingLine, shareButtonText, tipSeen } from '../../lib/multishare'
import { screenShareSupported } from '../../lib/phone'
import { useWatch, watchStore } from '../../watching/store'

/**
 * CONTRACT-V12-WATCHING §4–§5, over the stage while anybody shares a screen:
 * who is sharing ("Ayşe ve Mehmet ekran paylaşıyor"), the layout switch
 * (Yan yana / Odak, from two screens), "Sen de paylaş" for somebody who could
 * share and is not (the owner did not know several people can share at once:
 * the button says so), the cap when the room is at it, and once, the first
 * time somebody else shares, a one-line tip.
 */
export function StageToolbar({
  voice,
  sharers,
  me,
  nameOf,
  max,
  onShare,
}: {
  voice: VoiceSnapshot
  /** Who shares in my room now (participants' `screensharing`), me included. */
  sharers: readonly number[]
  me: number
  nameOf: (userId: number) => string
  /** `ready.screen_shares_max`, or null from an older server. */
  max: number | null
  onShare: () => void
}) {
  const watch = useWatch()
  const [tip, setTip] = useState(() => !tipSeen())
  const others = sharers.filter((id) => id !== me)
  const screens = voice.remoteVideo.length + (voice.localScreen ? 1 : 0)
  if (voice.status === 'idle' || sharers.length === 0) return null
  const names = [...others.map(nameOf), ...(voice.screensharing ? ['Sen'] : [])]
  const line = sharingLine(names)
  const button = shareButtonText({ sharing: voice.screensharing, others: others.length, max })
  const showTip = tip && others.length > 0 && !voice.screensharing && screenShareSupported()

  return (
    <div className="v12-toolbar" data-testid="stage-toolbar">
      <span className="v12-sharing-line" data-testid="stage-sharing-line" data-count={sharers.length}>
        {line}
      </span>
      {screens >= 2 && (
        <div className="v12-mode" role="group" aria-label="Ekranların düzeni">
          <button
            type="button"
            className={watch.stageMode === 'side' ? 'on' : undefined}
            data-testid="stage-mode-side"
            aria-pressed={watch.stageMode === 'side'}
            title="Ekranlar eşit boyda, yan yana"
            onClick={() => watchStore.update({ stageMode: 'side' })}
          >
            Yan yana
          </button>
          <button
            type="button"
            className={watch.stageMode === 'focus' ? 'on' : undefined}
            data-testid="stage-mode-focus"
            aria-pressed={watch.stageMode === 'focus'}
            title="Biri büyük, diğerleri altta küçük (← → ya da 1–9 ile değiştir)"
            onClick={() => watchStore.update({ stageMode: 'focus' })}
          >
            Odak
          </button>
        </div>
      )}
      {!voice.screensharing && others.length > 0 && screenShareSupported() && (
        <button
          type="button"
          className="v12-share-too"
          data-testid="stage-share-too"
          data-full={button.full}
          aria-disabled={button.full || voice.screenStarting || undefined}
          title={button.title}
          onClick={() => {
            if (button.full || voice.screenStarting) return
            markTipSeen()
            setTip(false)
            onShare()
          }}
        >
          {voice.screenStarting ? 'Başlıyor…' : button.label}
        </button>
      )}
      {showTip && (
        <p className="v12-tip" data-testid="multishare-tip" role="note">
          Aynı anda birden fazla kişi ekran paylaşabilir: sen de paylaşırsan {names[0]} paylaşmayı sürdürür.
          <button
            type="button"
            className="ghost small"
            data-testid="multishare-tip-close"
            aria-label="Anladım"
            onClick={() => {
              markTipSeen()
              setTip(false)
            }}
          >
            Anladım
          </button>
        </p>
      )}
    </div>
  )
}
