import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSinkId } from '../useSinkId'
import { useRemoteVolume } from '../useRemoteVolume'
import type { RemoteMedia } from '../voice'
import { ExpandIcon } from './icons2'

/**
 * v2 stage (CONTRACT-V2 §4): shared screens AND cameras, several people at
 * once. N tiles in a grid; a clicked tile becomes large with the others in a
 * strip below it (click it again to go back); each tile has a fullscreen
 * button (or F on a focused tile).
 */

export type TileKind = 'screen' | 'camera'

export interface StageTile {
  key: string
  kind: TileKind
  stream: MediaStream
  label: string
  testId: string
  /** Local previews and cameras never play sound. */
  silent: boolean
  /** Own camera preview, mirrored like a mirror. */
  mirrored: boolean
  userId: number | null
}

/** Columns for N tiles: 1, 2, 2, 2, 3, 3, 3, 3, 3, then 4. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

export function buildTiles(input: {
  remoteScreens: readonly RemoteMedia[]
  remoteCameras: readonly RemoteMedia[]
  localScreen: MediaStream | null
  localCamera: MediaStream | null
  nameOf: (userId: number) => string
}): StageTile[] {
  const tiles: StageTile[] = []
  const byUser = new Map<number, StageTile[]>()
  const push = (tile: StageTile) => {
    const list = byUser.get(tile.userId ?? -1) ?? []
    list.push(tile)
    byUser.set(tile.userId ?? -1, list)
  }
  for (const media of input.remoteScreens) {
    push({
      key: `screen-${media.userId}-${media.stream.id}`,
      kind: 'screen',
      stream: media.stream,
      label: `${input.nameOf(media.userId)} · ekran`,
      testId: 'remote-video',
      silent: false,
      mirrored: false,
      userId: media.userId,
    })
  }
  for (const media of input.remoteCameras) {
    push({
      key: `camera-${media.userId}-${media.stream.id}`,
      kind: 'camera',
      stream: media.stream,
      label: input.nameOf(media.userId),
      testId: `remote-camera-${media.userId}`,
      silent: true,
      mirrored: false,
      userId: media.userId,
    })
  }
  // Remote people in user-id order, each with screen first; own tiles last.
  for (const userId of [...byUser.keys()].sort((a, b) => a - b)) tiles.push(...(byUser.get(userId) ?? []))
  if (input.localScreen) {
    tiles.push({
      key: `local-screen-${input.localScreen.id}`,
      kind: 'screen',
      stream: input.localScreen,
      label: 'Senin ekranın',
      testId: 'local-video',
      silent: true,
      mirrored: false,
      userId: null,
    })
  }
  if (input.localCamera) {
    tiles.push({
      key: `local-camera-${input.localCamera.id}`,
      kind: 'camera',
      stream: input.localCamera,
      label: 'Sen',
      testId: 'local-camera',
      silent: true,
      mirrored: true,
      userId: null,
    })
  }
  return tiles
}

function Tile({
  tile,
  deafened,
  focused,
  small,
  onActivate,
  overlay,
}: {
  tile: StageTile
  deafened: boolean
  focused: boolean
  small: boolean
  onActivate: () => void
  /** V6: controls drawn over the tile (İzlemeyi bırak, who watches). */
  overlay?: (tile: StageTile) => ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const figure = useRef<HTMLElement>(null)
  const muted = tile.silent || deafened
  useSinkId(video, !tile.silent)

  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = tile.stream
    void element.play().catch(() => undefined)
    return () => {
      element.pause()
      element.srcObject = null
    }
  }, [tile.stream])

  // V6: deafen, and the "Yayın sesi" volume of a shared screen (0–200 %).
  useRemoteVolume(video, tile.stream, tile.userId, 'stream', deafened, tile.silent)

  const fullscreen = () => {
    const element = figure.current
    if (!element) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else if (element.requestFullscreen) void element.requestFullscreen().catch(() => undefined)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate()
    } else if (event.key === 'f' || event.key === 'F') {
      event.preventDefault()
      fullscreen()
    }
  }

  return (
    <figure
      ref={figure}
      className={`call-tile ${tile.kind}${focused ? ' focused' : ''}${small ? ' small' : ''}`}
      data-kind={tile.kind}
      data-user-id={tile.userId ?? 'me'}
      role="button"
      tabIndex={0}
      aria-pressed={focused}
      aria-label={`${tile.label}${focused ? ' (büyütülmüş)' : ''}`}
      title={focused ? 'Küçültmek için tıkla' : 'Büyütmek için tıkla'}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={muted}
        data-testid={tile.testId}
        data-kind={tile.kind}
        className={tile.mirrored ? 'mirrored' : undefined}
      />
      <figcaption>{tile.label}</figcaption>
      {overlay?.(tile)}
      <button
        type="button"
        className="icon-button small call-tile-full"
        title="Tam ekran"
        aria-label={`Tam ekran: ${tile.label}`}
        onClick={(event) => {
          event.stopPropagation()
          fullscreen()
        }}
      >
        <ExpandIcon size={14} />
      </button>
    </figure>
  )
}

export function CallStage({
  remoteScreens,
  remoteCameras,
  localScreen,
  localCamera,
  deafened,
  nameOf,
  overlay,
  hide,
  footer,
}: {
  remoteScreens: readonly RemoteMedia[]
  remoteCameras: readonly RemoteMedia[]
  localScreen: MediaStream | null
  localCamera: MediaStream | null
  deafened: boolean
  nameOf: (userId: number) => string
  /** V6: drawn over each tile. */
  overlay?: (tile: StageTile) => ReactNode
  /** V6: tiles left off the stage (a screen I stopped watching). */
  hide?: (tile: StageTile) => boolean
  /** V6: under the tiles (the room's people); also shown when every tile is hidden. */
  footer?: ReactNode
}) {
  const allTiles = useMemo(
    () => buildTiles({ remoteScreens, remoteCameras, localScreen, localCamera, nameOf }),
    [remoteScreens, remoteCameras, localScreen, localCamera, nameOf],
  )
  const tiles = hide ? allTiles.filter((tile) => !hide(tile)) : allTiles
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const focused = tiles.find((tile) => tile.key === focusKey) ?? null

  // V6: the people strip sits right under the stage (and stays when every tile is hidden).
  const people = footer ? <div className="call-stage-people">{footer}</div> : null
  if (tiles.length === 0) return people

  const activate = (key: string) => setFocusKey((current) => (current === key ? null : key))

  if (focused && tiles.length > 1) {
    const others = tiles.filter((tile) => tile !== focused)
    return (
      <>
      <section className="call-stage focus" aria-label="Kameralar ve paylaşılan ekranlar" data-testid="stage">
        <div className="call-stage-main">
          <Tile tile={focused} deafened={deafened} focused small={false} onActivate={() => activate(focused.key)} overlay={overlay} />
        </div>
        <div className="call-stage-strip">
          {others.map((tile) => (
            <Tile key={tile.key} tile={tile} deafened={deafened} focused={false} small onActivate={() => activate(tile.key)} overlay={overlay} />
          ))}
        </div>
      </section>
      {people}
      </>
    )
  }

  const columns = gridColumns(tiles.length)
  return (
    <>
    <section
      className="call-stage grid"
      aria-label="Kameralar ve paylaşılan ekranlar"
      data-testid="stage"
      data-count={tiles.length}
      style={{ ['--stage-columns' as string]: String(columns), ['--stage-rows' as string]: String(Math.ceil(tiles.length / columns)) }}
    >
      {tiles.map((tile) => (
        <Tile
          key={tile.key}
          tile={tile}
          deafened={deafened}
          focused={tile.key === focusKey}
          small={false}
          onActivate={() => activate(tile.key)}
          overlay={overlay}
        />
      ))}
    </section>
    {people}
    </>
  )
}
