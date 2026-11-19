import { useCallback } from 'react'
import type { ServerProfile } from '../types'
import { ImageField } from './ImageField'
import { NameForm } from './NameForm'
import { ServerIcon } from './ServerMark'

export interface ServerSettingsProps {
  server: ServerProfile
  rename: (name: string) => Promise<string>
  setIcon: (blob: Blob, ext: string) => Promise<void>
  removeIcon: () => Promise<void>
  onEditing: (key: string, editing: boolean) => void
}

/** Ayarlar › Sunucu: the server's name and icon, which any member may change. */
export function ServerSection({ settings }: { settings: ServerSettingsProps }) {
  const { server, onEditing } = settings
  const onIconEditing = useCallback((editing: boolean) => onEditing('server-icon', editing), [onEditing])
  const onNameEditing = useCallback((editing: boolean) => onEditing('server-name', editing), [onEditing])
  return (
    <section className="settings-section server-section" aria-labelledby="settings-server" data-testid="settings-server">
      <h3 id="settings-server">Sunucu</h3>
      <p className="settings-hint">Sunucunun adını ve simgesini herkes değiştirebilir; değişiklik herkese hemen yansır.</p>
      <ImageField
        testId="server-icon-field"
        label="Simge"
        preview={
          <span className="server-icon-preview">
            <ServerIcon server={server} size={48} testId="server-icon-preview" />
          </span>
        }
        hasImage={Boolean(server.icon_url)}
        shape="rounded"
        cropTitle="Sunucu simgesini kırp"
        upload={settings.setIcon}
        remove={settings.removeIcon}
        onEditing={onIconEditing}
      />
      <NameForm testId="server-rename" label="Sunucunun adı" value={server.name} save={settings.rename} onEditing={onNameEditing} />
    </section>
  )
}
