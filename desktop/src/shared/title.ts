/**
 * The web client puts its unread count in the tab title as a leading "(n)",
 * e.g. "(3) Trio". Anything else means zero.
 */
const UNREAD_PREFIX = /^\s*\((\d{1,6})\)/;

export function parseUnread(title: string | null | undefined): number {
  if (!title) return 0;
  const match = UNREAD_PREFIX.exec(title);
  if (!match) return 0;
  const n = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** What a badge shows: the number, capped at "99+". */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}
