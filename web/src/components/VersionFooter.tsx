import { CLIENT_BUILD, CLIENT_VERSION, versionLine } from '../lib/version'

/** Ayarlar's last line (CONTRACT-V4 A2): "Trio 0.3.0 (202611190135) · sunucu 0.2.0". */
export function VersionFooter({ serverVersion }: { serverVersion: string | null }) {
  return (
    <footer
      className="settings-versions"
      data-testid="settings-versions"
      data-client-version={CLIENT_VERSION}
      data-client-build={CLIENT_BUILD}
      data-server-version={serverVersion ?? ''}
    >
      {versionLine(CLIENT_VERSION, CLIENT_BUILD, serverVersion)}
    </footer>
  )
}
