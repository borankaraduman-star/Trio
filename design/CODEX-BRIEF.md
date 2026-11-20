# Trio — design brief for Codex (image generation)

Run Codex from the repository root and give it this file. It should generate
the images below with its image-generation tool, save them at the exact paths
and sizes listed, and change no source code.

## What Trio is

A private voice and text chat app for a small group (a friend group, a small
team or a small community, up to about 10–15 people) on a server the group
runs itself: text channels, voice rooms, screen sharing, camera.
Web app plus an Electron desktop app. The UI is dark, calm and compact; UI
text is Turkish.

## Direction

- Mood: a small private room for people who know each other, not a gaming
  brand and not a corporate tool. Warm,
  quiet, a little playful. No neon, no "gamer" aesthetics, no mascots with
  faces.
- Motif (the mark, chosen when this brief was first written): three dots,
  three overlapping circles or three sound waves meeting. It is the logo
  only; the product is not about the number three, so no picture should
  read as "three people". One simple idea, readable at 16 px.
- Palette: deep neutral background (#111318 to #1a1d24), one warm accent
  (propose one; amber/coral family) and one cool secondary for "online/speaking"
  (teal/green family). State the final hex values in `design/palette.md`.
- Flat or soft-gradient shapes, generous padding, no text inside icons, no
  photorealism, no stock-looking 3D.

## Deliverables

| # | file | size | notes |
|---|---|---|---|
| 1 | `design/concepts/logo-a.png`, `logo-b.png`, `logo-c.png` | 1024×1024 | three distinct logo-mark concepts on the dark background, for the owner to choose from |
| 2 | `desktop/build/icon.png` | 1024×1024 | chosen app icon, full-bleed rounded-square, no transparency issues at the edges |
| 3 | `web/public/icon-512.png`, `web/public/icon-192.png` | 512, 192 | same mark, for the web app manifest |
| 4 | `web/public/favicon.png` | 64×64 | simplified mark that still reads at 16 px |
| 5 | `desktop/assets/tray.png`, `tray@2x.png` | 16×16, 32×32 | transparent background, single light colour (works on a dark tray) |
| 6 | `desktop/assets/trayTemplate.png`, `trayTemplate@2x.png` | 16×16, 32×32 | macOS template image: pure black shape on transparent |
| 7 | `web/public/art/join.png` | 1600×1200 | soft abstract background for the join screen; must stay quiet behind a centred form |
| 8 | `web/public/art/empty-chat.png` | 800×600, transparent | illustration for a channel with no messages yet |
| 9 | `web/public/art/empty-voice.png` | 800×600, transparent | illustration for an empty voice room |
| 10 | `design/mockups/main.png` | 1920×1200 | mockup of the main screen: left sidebar (text channels, voice channel with three participants and a speaking ring), centre chat with a shared screen on a stage above it, right member list, bottom user panel with mic / headphones / camera / screen / hang-up buttons |
| 11 | `design/mockups/mobile.png` | 780×1688 | the same at phone width, sidebar as a drawer |
| 12 | `design/palette.md` | — | final hex values (background levels, surface, border, text, muted text, accent, online, speaking, danger) and one line each on where it is used |

After generating: downscale with a proper resampler rather than regenerating
small sizes, check every PNG opens and has the stated pixel size, and list
the files with their dimensions in the final message.
