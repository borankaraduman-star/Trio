import type { Level } from '../../lib/notify/pushApi'

/** The levels' names; the menu itself is components/reading/ChannelMenu.tsx (V7-READING §6). */
export const LEVEL_LABELS: Record<Level, string> = {
  all: 'Hepsi',
  mentions: 'Yalnız @ben',
  none: 'Kapalı',
}
