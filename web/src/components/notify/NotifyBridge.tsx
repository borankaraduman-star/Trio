import { useEffect, useRef } from 'react'
import type { Channel, ClientEvent, Member } from '../../types'
import { notifyHub } from '../../lib/notify/notifyHub'
import { onViewingChange } from '../../lib/viewing'
import { InstallCard } from './InstallCard'

/**
 * Session's one mount point for CONTRACT-V6-PUSH: attaches `notifyHub`, keeps
 * the server told whether this tab is being looked at (and at which channel),
 * routes notification clicks (`trio.open` from the worker, `?open=` when the
 * worker had to open a new window), and draws the install card and the
 * channel menu.
 */
export function NotifyBridge(props: {
  token: string
  myId: number
  ready: boolean
  channels: readonly Channel[]
  users: Record<number, Member>
  activeChannelId: number | null
  send: (event: ClientEvent) => boolean
  onSelectChannel: (channelId: number) => void
  onOpenDrawer: () => void
  onUnauthorized: () => void
}) {
  const latest = useRef(props)
  latest.current = props

  useEffect(
    () =>
      notifyHub.attach({
        token: props.token,
        myId: props.myId,
        channels: () => latest.current.channels,
        names: () => {
          const names: Record<number, string> = {}
          for (const [id, user] of Object.entries(latest.current.users)) names[Number(id)] = user.name
          return names
        },
        activeChannelId: () => latest.current.activeChannelId,
        send: (event) => latest.current.send(event),
        open: (channelId) => {
          const channel = latest.current.channels.find((c) => c.id === channelId)
          if (channel?.kind === 'text') latest.current.onSelectChannel(channel.id)
          else if (channel?.kind === 'voice') latest.current.onOpenDrawer()
          window.focus()
        },
        onUnauthorized: () => latest.current.onUnauthorized(),
      }),
    [props.token, props.myId],
  )

  useEffect(() => onViewingChange(() => notifyHub.reportViewing()), [])
  useEffect(() => {
    notifyHub.reportViewing()
  }, [props.activeChannelId])

  // `?open=<id>&kind=…`: the worker opened this window for a notification.
  const opened = useRef(false)
  useEffect(() => {
    if (!props.ready || opened.current) return
    opened.current = true
    const params = new URLSearchParams(window.location.search)
    const open = Number(params.get('open'))
    if (!params.has('open')) return
    params.delete('open')
    params.delete('kind')
    const rest = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
    const channel = props.channels.find((c) => c.id === open)
    if (channel?.kind === 'text') props.onSelectChannel(channel.id)
    else if (channel?.kind === 'voice') props.onOpenDrawer()
  }, [props.ready, props.channels, props])

  return (
    <>
      <InstallCard />
    </>
  )
}
