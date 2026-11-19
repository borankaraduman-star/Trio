import { useCallback } from 'react'
import type { User } from '../types'
import { Avatar } from './Avatar'
import { ImageField } from './ImageField'
import { NameForm } from './NameForm'

export interface ProfileProps {
  me: User
  rename: (name: string) => Promise<string>
  setAvatar: (blob: Blob, ext: string) => Promise<void>
  removeAvatar: () => Promise<void>
  /** The reload guard: `key` is being edited (the cropper is open, a name is typed). */
  onEditing: (key: string, editing: boolean) => void
}

/** Ayarlar › Hesap: one's picture and name (CONTRACT-V4 C). */
export function ProfileFields({ profile }: { profile: ProfileProps }) {
  const { me, onEditing } = profile
  const onAvatarEditing = useCallback((editing: boolean) => onEditing('avatar', editing), [onEditing])
  const onNameEditing = useCallback((editing: boolean) => onEditing('name', editing), [onEditing])
  return (
    <div className="profile-fields" data-testid="profile-fields">
      <ImageField
        testId="avatar"
        label="Profil fotoğrafı"
        preview={<Avatar id={me.id} name={me.name} size={64} url={me.avatar_url} />}
        hasImage={Boolean(me.avatar_url)}
        shape="circle"
        cropTitle="Profil fotoğrafını kırp"
        upload={profile.setAvatar}
        remove={profile.removeAvatar}
        onEditing={onAvatarEditing}
      />
      <NameForm testId="rename" label="Adını değiştir" value={me.name} save={profile.rename} onEditing={onNameEditing} />
    </div>
  )
}
