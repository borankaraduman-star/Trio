import { useState, type ReactNode } from 'react'
import type { VoiceSnapshot } from '../../voice'
import { ScreenIcon } from '../icons'
import { ChevronIcon } from '../voice/icons'
import { loadStageCollapsed, saveStageCollapsed, stageSources } from '../../lib/phone'

/**
 * CONTRACT-V7-PHONE §3: on a phone the stage (shared screens, cameras, the
 * room's people) can be collapsed to a one-line pill, remembered per device.
 *
 * Collapsing only HIDES the stage: the tiles stay mounted, their streams
 * keep playing (a shared screen's sound included) and nothing is signalled.
 * Not receiving a screen at all is the V6 "İzlemeyi bırak" (per screen,
 * told to the sharer); this is a layout choice and never becomes one.
 */
export function StageFrame({
  enabled,
  voice,
  nameOf,
  children,
}: {
  /** Only at phone width; elsewhere the stage is always open. */
  enabled: boolean
  voice: VoiceSnapshot
  nameOf: (userId: number) => string
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(loadStageCollapsed)
  const sources = stageSources(
    {
      remoteScreens: voice.remoteVideo,
      hiddenScreens: voice.hiddenScreens,
      remoteCameras: voice.remoteCamera,
      localScreen: voice.localScreen,
      localCamera: voice.localCamera,
    },
    nameOf,
  )
  const active = enabled && voice.status !== 'idle' && sources.length > 0

  const set = (value: boolean) => {
    setCollapsed(value)
    saveStageCollapsed(value)
  }

  return (
    // One wrapper always (display: contents while inactive): the stage's tiles
    // are never remounted by the frame appearing or going.
    <div className="v7-stage" data-testid="stage-frame" data-active={active} data-collapsed={active && collapsed}>
      {!active ? null : collapsed ? (
        <button
          type="button"
          className="v7-stage-pill"
          data-testid="stage-expand"
          aria-expanded={false}
          aria-label={`Görüntüleri göster: ${sources.join(', ')}`}
          onClick={() => set(false)}
        >
          <ScreenIcon size={16} />
          <span className="v7-stage-pill-text">{sources.join(', ')}</span>
          <span className="v7-stage-pill-action">
            Göster <ChevronIcon size={14} />
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="v7-stage-collapse"
          data-testid="stage-collapse"
          aria-expanded
          aria-label="Görüntüleri küçült"
          title="Görüntüleri küçült"
          onClick={() => set(true)}
        >
          <ChevronIcon size={16} />
          <span>Küçült</span>
        </button>
      )}
      <div className="v7-stage-body">
        {children}
      </div>
    </div>
  )
}
