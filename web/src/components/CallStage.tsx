import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSinkId } from '../useSinkId'
import { useRemoteVolume } from '../useRemoteVolume'
import type { RemoteMedia } from '../voice'
import { ExpandIcon } from './icons2'
import { stageTileLimit } from '../lib/groups'
import { PHONE_QUERY, useMediaQuery } from '../lib/phone'
import { sideBySide } from '../lib/multishare'
import { useShareSize } from '../watching/useShareSize'
import { focusedShare, shareOrder, useWatch, watchStore } from '../watching/store'

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

/**
 * V10 (CONTRACT-V10-GROUPS §3): on a crowded stage, which tiles show and how
 * many fold into "+N". Screens first (they carry sound and are what people
 * gathered for), then cameras in their order; my own tiles last. Folded tiles
 * stay mounted and playing (hidden with CSS), like the V7 collapse.
 */
export function stageLayout(tiles: readonly StageTile[], limit: number, showAll: boolean): { shown: StageTile[]; folded: StageTile[] } {
  const ordered = [
    ...tiles.filter((tile) => tile.kind === 'screen' && tile.userId !== null),
    ...tiles.filter((tile) => tile.kind === 'camera' && tile.userId !== null),
    ...tiles.filter((tile) => tile.userId === null),
  ]
  if (showAll || ordered.length <= limit) return { shown: ordered, folded: [] }
  return { shown: ordered.slice(0, limit - 1), folded: ordered.slice(limit - 1) }
}

function Tile({
  tile,
  deafened,
  focused,
  small,
  onActivate,
  overlay,
  folded = false,
  multi = false,
}: {
  /** V12: one of several screens on the stage (sized by what it shows). */
  multi?: boolean
  tile: StageTile
  deafened: boolean
  focused: boolean
  small: boolean
  /** V10: behind "+N": mounted and playing, not shown. */
  folded?: boolean
  onActivate: () => void
  /** V6: controls drawn over the tile (İzlemeyi bırak, who watches). */
  overlay?: (tile: StageTile) => ReactNode
}) {
  const video = useRef<HTMLVideoElement>(null)
  const figure = useRef<HTMLElement>(null)
  const muted = tile.silent || deafened
  useSinkId(video, !tile.silent)
  // V12: how large this place shows a remote screen (the sharer sends that size to me).
  useShareSize(tile.kind === 'screen' && tile.userId !== null ? tile.userId : null, video, !folded, null, !multi && !small)

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
      className={`call-tile ${tile.kind}${focused ? ' focused' : ''}${small ? ' small' : ''}${folded ? ' folded' : ''}`}
      aria-hidden={folded || undefined}
      data-kind={tile.kind}
      data-user-id={tile.userId ?? 'me'}
      role="button"
      tabIndex={0}
      aria-pressed={focused}
      aria-label={`${tile.label}${focused ? ' (büyütülmüş)' : ''}`}
      title={focused ? 'Küçültmek için tıkla' : 'Büyütmek için tıkla'}
      onClick={onActivate}
      onDoubleClick={(event) => {
        // V12: a double click is the real fullscreen (on the monitor the window is on).
        event.preventDefault()
        fullscreen()
      }}
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
  toolbar,
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
  /** V12: over the stage (the layout switch, who is sharing, "Sen de paylaş"). */
  toolbar?: ReactNode
}) {
  const allTiles = useMemo(
    () => buildTiles({ remoteScreens, remoteCameras, localScreen, localCamera, nameOf }),
    [remoteScreens, remoteCameras, localScreen, localCamera, nameOf],
  )
  const tiles = hide ? allTiles.filter((tile) => !hide(tile)) : allTiles
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const focused = tiles.find((tile) => tile.key === focusKey) ?? null
  const phone = useMediaQuery(PHONE_QUERY)
  const [showAll, setShowAll] = useState(false)
  const watch = useWatch()

  // V6: the people strip sits right under the stage (and stays when every tile is hidden).
  const people = footer ? <div className="call-stage-people">{footer}</div> : null
  if (tiles.length === 0) return people

  const activate = (key: string) => setFocusKey((current) => (current === key ? null : key))
  const bar = toolbar ? <div className="v12-stage-bar">{toolbar}</div> : null

  // V12 (CONTRACT-V12-WATCHING §4): two or more screens get their own layout,
  // "Yan yana" (equal, as large as the stage allows) or "Odak" (one large).
  const screens = tiles.filter((tile) => tile.kind === 'screen')
  if (screens.length >= 2) {
    return (
      <>
        {bar}
        <MultiStage
          tiles={tiles}
          screens={screens}
          deafened={deafened}
          overlay={overlay}
          phone={phone}
          mode={focused ? 'focus' : watch.stageMode}
          focusKey={focused?.key ?? null}
          pinned={watch.pinned}
          focusUser={watch.focus}
          onActivate={activate}
        />
        {people}
      </>
    )
  }

  if (focused && tiles.length > 1) {
    const others = tiles.filter((tile) => tile !== focused)
    return (
      <>
      {bar}
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

  const limit = stageTileLimit(phone)
  const { shown, folded } = stageLayout(tiles, limit, showAll)
  const more = folded.length > 0
  const less = showAll && tiles.length > limit
  const cells = shown.length + (more || less ? 1 : 0)
  // A phone showing every tile keeps two columns and scrolls (four were too small to read).
  const columns = phone && less ? 2 : gridColumns(cells)
  const rows = Math.ceil(cells / columns)
  return (
    <>
    {bar}
    <section
      className={`call-stage grid${showAll && tiles.length > limit ? ' all' : ''}`}
      aria-label="Kameralar ve paylaşılan ekranlar"
      data-testid="stage"
      data-count={tiles.length}
      data-shown={shown.length}
      style={{ ['--stage-columns' as string]: String(columns), ['--stage-rows' as string]: String(rows) }}
    >
      {[...shown, ...folded].map((tile) => (
        <Tile
          key={tile.key}
          tile={tile}
          deafened={deafened}
          focused={tile.key === focusKey}
          small={false}
          onActivate={() => activate(tile.key)}
          overlay={overlay}
          folded={folded.includes(tile)}
        />
      ))}
      {more && (
        <button
          type="button"
          className="call-tile stage-more"
          data-testid="stage-more"
          aria-label={`${folded.length} görüntü daha: hepsini göster (${folded.map((tile) => tile.label).join(', ')})`}
          title={folded.map((tile) => tile.label).join(', ')}
          onClick={() => setShowAll(true)}
        >
          <strong>+{folded.length}</strong>
          <span>Hepsini göster</span>
        </button>
      )}
      {less && (
        <button type="button" className="call-tile stage-more" data-testid="stage-less" onClick={() => setShowAll(false)}>
          <strong>−</strong>
          <span>Daha az göster</span>
        </button>
      )}
    </section>
    {people}
    </>
  )
}

/**
 * V12: two or more shared screens. "Yan yana": the screens in an equal grid
 * whose arrangement makes each as large as the stage allows for their shape
 * (two wide screens side by side, two ultrawide ones stacked), cameras in a
 * strip under them. "Odak": one screen large (the chosen one, else the
 * pinned one, else the first), every other tile in the strip, where each is
 * sent to me small (the strip reports `thumb`). ← / → move the focus, 1–9
 * pick a screen.
 */
function MultiStage({
  tiles,
  screens,
  deafened,
  overlay,
  phone,
  mode,
  focusKey,
  pinned,
  focusUser,
  onActivate,
}: {
  tiles: StageTile[]
  screens: StageTile[]
  deafened: boolean
  overlay?: (tile: StageTile) => ReactNode
  phone: boolean
  mode: 'side' | 'focus'
  /** A tile clicked into focus (temporary, as before V12). */
  focusKey: string | null
  pinned: number | null
  focusUser: number | null
  onActivate: (key: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(960)
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  const [aspects, setAspects] = useState<Record<string, number>>({})
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0) setWidth(rect.width)
    })
    observer.observe(element)
    const onResize = () => setViewport(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [mode])
  useEffect(() => {
    const element = box.current
    if (!element) return
    const onResize = (event: Event) => {
      const video = event.target as HTMLVideoElement
      const key = video.closest<HTMLElement>('[data-tile-key]')?.dataset.tileKey
      if (key && video.videoWidth > 0 && video.videoHeight > 0) {
        const aspect = video.videoWidth / video.videoHeight
        setAspects((current) => (Math.abs((current[key] ?? 0) - aspect) < 0.01 ? current : { ...current, [key]: aspect }))
      }
    }
    element.addEventListener('resize', onResize, true)
    element.addEventListener('loadedmetadata', onResize, true)
    return () => {
      element.removeEventListener('resize', onResize, true)
      element.removeEventListener('loadedmetadata', onResize, true)
    }
  }, [])

  // Remote screens by sharer, pinned first; mine last.
  const remote = screens.filter((tile) => tile.userId !== null)
  const order = shareOrder(remote.map((tile) => tile.userId as number), pinned)
  const orderedScreens = [
    ...order.map((id) => remote.find((tile) => tile.userId === id) as StageTile),
    ...screens.filter((tile) => tile.userId === null),
  ]
  const others = tiles.filter((tile) => tile.kind !== 'screen')
  const chosen =
    focusKey !== null
      ? (tiles.find((tile) => tile.key === focusKey) ?? null)
      : mode === 'focus'
        ? (remote.find((tile) => tile.userId === focusedShare(order, focusUser, pinned)) ?? orderedScreens[0])
        : null
  const main = chosen ? [chosen] : orderedScreens
  const stripOrdered = chosen ? [...orderedScreens.filter((t) => t !== chosen), ...others.filter((t) => t !== chosen)] : others

  const known = main.map((tile) => aspects[tile.key]).filter((a): a is number => typeof a === 'number')
  const aspect = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 16 / 9
  // The screens may take up to ~62 % of the window's height, less the strip under them.
  const room = Math.max(160, viewport * (phone ? 0.5 : 0.62) - (stripOrdered.length > 0 ? (phone ? 74 : 106) : 0) - 24)
  const grid = chosen ? { columns: 1, rows: 1, tileHeight: Math.floor(room) } : sideBySide(main.length, width, room, aspect)

  const move = (step: number) => {
    const current = chosen?.userId ?? focusedShare(order, focusUser, pinned)
    const at = order.indexOf(current ?? -1)
    const next = order[(at + step + order.length) % order.length]
    if (next !== undefined) watchStore.update({ focus: next, stageMode: 'focus' })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (mode !== 'focus') return
      event.preventDefault()
      move(event.key === 'ArrowRight' ? 1 : -1)
    } else if (/^[1-9]$/.test(event.key)) {
      const target = order[Number(event.key) - 1]
      if (target === undefined) return
      event.preventDefault()
      watchStore.update({ focus: target, stageMode: 'focus' })
    }
  }

  return (
    <section
      className={`call-stage v12-multi ${chosen ? 'focus' : 'side'}${phone ? ' phone' : ''}`}
      aria-label="Paylaşılan ekranlar ve kameralar"
      data-testid="stage"
      data-layout={chosen ? 'focus' : 'side'}
      data-count={tiles.length}
      data-shown={tiles.length}
      data-screens={screens.length}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div
        ref={box}
        className="v12-main"
        style={{
          ['--v12-columns' as string]: String(grid.columns),
          ['--v12-rows' as string]: String(grid.rows),
          ['--v12-height' as string]: `${grid.tileHeight * grid.rows + 10 * (grid.rows - 1)}px`,
        }}
      >
        {main.map((tile) => (
          <div key={tile.key} className="v12-cell" data-tile-key={tile.key}>
            <Tile
              tile={tile}
              deafened={deafened}
              focused={chosen === tile}
              small={false}
              multi
              onActivate={() => {
                if (mode === 'focus' && focusKey === null) return
                onActivate(tile.key)
              }}
              overlay={overlay}
            />
          </div>
        ))}
      </div>
      {stripOrdered.length > 0 && (
        <div className="call-stage-strip v12-strip">
          {stripOrdered.map((tile) => (
            <div key={tile.key} className="v12-cell small" data-tile-key={tile.key}>
              <Tile
                tile={tile}
                deafened={deafened}
                focused={false}
                small
                multi
                onActivate={() => {
                  if (tile.kind === 'screen' && tile.userId !== null && mode === 'focus' && focusKey === null) {
                    watchStore.update({ focus: tile.userId })
                  } else onActivate(tile.key)
                }}
                overlay={overlay}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
