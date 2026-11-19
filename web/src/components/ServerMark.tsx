import { useState } from 'react'
import type { ServerProfile } from '../types'
import { BrandMark } from './BrandMark'
import { DEFAULT_SERVER } from '../lib/identity'

/** The server's icon: its picture, else (and when the picture fails to load) the Trio mark. */
export function ServerIcon({ server, size, testId }: { server: ServerProfile; size: number; testId?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const icon = server.icon_url && failed !== server.icon_url ? server.icon_url : null
  if (!icon) return <BrandMark size={size} />
  return (
    <img
      key={icon}
      className="server-icon"
      data-testid={testId}
      src={icon}
      width={size}
      height={size}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(icon)}
    />
  )
}

/** The sidebar header (CONTRACT-V4 C): the server's icon and its name. */
export function ServerMark({ server = DEFAULT_SERVER, size = 22 }: { server?: ServerProfile; size?: number }) {
  return (
    <span className="server-mark" data-testid="server-mark">
      <ServerIcon server={server} size={size} testId="server-icon" />
      <span className="server-name" data-testid="server-name" title={server.name}>
        {server.name}
      </span>
    </span>
  )
}
