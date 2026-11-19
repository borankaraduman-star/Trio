/**
 * Who a user is, as the screen shows them (CONTRACT-V4 C): the current name
 * and avatar from the member list, the server's own name and icon.
 */
import type { Member, ServerProfile, User } from '../types'

export const DEFAULT_SERVER_NAME = 'Trio'

export const DEFAULT_SERVER: ServerProfile = { name: DEFAULT_SERVER_NAME, icon_url: null }

/** A relative URL the server hands out for an image (never another origin, never a scheme). */
function imagePath(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/api/') ? value : null
}

/** A server profile from the wire, or null when it is not one (an older server sends none). */
export function serverProfile(value: unknown): ServerProfile | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, icon_url } = value as { name?: unknown; icon_url?: unknown }
  if (typeof name !== 'string' || name.trim() === '') return null
  return { name, icon_url: imagePath(icon_url) }
}

/**
 * A user from the wire with an `avatar_url` that is ours or null. A server
 * that predates avatars sends none, and the object is left as it came.
 */
export function normalizeUser<T extends User>(user: T): T {
  if (!('avatar_url' in user)) return user
  const avatar_url = imagePath(user.avatar_url)
  return avatar_url === user.avatar_url ? user : { ...user, avatar_url }
}

/**
 * The author a message row shows: the CURRENT user when they are still a
 * member (a rename or a new avatar reaches old messages at once, since
 * authors are joined by id), else the snapshot the message carries (a
 * former member). Returns an existing object, so memoised rows stay put.
 */
export function resolveAuthor(author: User, users: Readonly<Record<number, Member>> | undefined): User {
  return users?.[author.id] ?? author
}

