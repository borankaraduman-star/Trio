# Trio — contract, sixth layer: media and everyday chat (adds to v1–v5; where they differ, this wins)

Everything is additive: an older client keeps working against this server
(new fields are ignored, new multipart parts are optional), and this client
keeps working against an older server (it falls back where noted).

## 1. Photos are made smaller in the browser (client only)

A picture that is picked, pasted or dropped is prepared before upload
(`web/src/lib/photoPlan.ts` decides, `photoProcess.ts` moves the pixels, in a
module worker with an `OffscreenCanvas` — `photoWorker.ts`; on the page when no
worker can):

- decoded with `createImageBitmap(file, {imageOrientation: 'from-image'})`
  (the EXIF orientation is applied — verified in Chromium 1243: a 4000×3000
  JPEG with orientation 6 decodes as 3000×4000, upright);
- types tried: `image/jpeg`, `image/png`, `image/webp`, `image/heic`/`heif`
  (by type, or by extension when the browser gives none). A picture the
  browser cannot decode (HEIC on Chromium) goes up unchanged. GIFs are never
  touched (animation);
- left alone when under 300 KB **and** at most 2048 px on its longest edge;
- otherwise scaled to a longest edge of at most 2048 px and encoded as WebP
  (quality 0.82; 0.9 for PNG sources, usually screenshots). Where the browser
  cannot encode WebP (`toBlob`/`convertToBlob` answer with another type — the
  OUTPUT type is checked, not a feature list) JPEG is used, except for a
  picture with transparency, which is then sent as picked (never flattened);
- the re-encoded copy is used only when it is smaller than the original; its
  name gets the new extension (`IMG_2041.JPG` → `IMG_2041.webp`);
- re-encoding builds a new file from pixels, so EXIF (GPS, camera, time), XMP
  and comments are gone. The chip says so ("konum bilgisi silindi") and shows
  the size before → after;
- "Orijinali gönder" on the chip (off by default, remembered per device in
  `localStorage` `trio.sendOriginal`) sends pictures as picked. Changing it
  prepares the pending pictures again; a copy already uploaded is left for the
  24-hour orphan sweep (it counts in the quota until then).

## 2. Previews and sizes

    POST /api/uploads   multipart: `file` (as before) and, optionally:
        preview             a file part: a small picture of an image
        voice_duration_ms   text: 1–130000
        voice_waveform      text: 64 comma-separated integers 0–255
      422 INVALID_PREVIEW   preview over 200 KiB, not a well-formed PNG/JPEG/still
                            WebP (images.py's avatar checks), a side over 640 px,
                            or the file is not an image (png/jpeg/gif/webp/avif)
      422 INVALID_VOICE     only one of the two voice fields, a bad number, not
                            64 bars, a field over 1 KiB, or the file is not audio/*
      413 QUOTA_EXCEEDED    the file plus its preview do not fit the quota
    GET  /api/previews/{attachment id}   NO auth (the id is the capability)
      → the preview's bytes, Content-Type its verified type, `inline`,
        `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`,
        `Cache-Control: private, max-age=31536000, immutable`. 404 otherwise.

`Attachment` gains (always present from this server, null when unknown):

    preview_url   "/api/previews/<id>" or null
    width,height  the ORIGINAL's shown size (PNG IHDR, GIF screen, WebP VP8/VP8L/VP8X,
                  JPEG SOF with the EXIF orientation applied: 5–8 swap them), else null
    voice         {duration_ms, waveform: [64 × 0..255]} or null

- The preview is stored as `<uploads>/previews/<id>`, is not an attachment of
  its own, counts in the uploader's quota (`stored_bytes` = size + preview
  size), and goes with its attachment: message delete, the orphan sweep, and
  at start-up any preview whose row is gone. Old attachments have none.
- Unknown extra parts are ignored (as before), so an older server simply
  stores the file; the client, if a server refuses the preview, sends the
  file again without it.
- Client: a preview is made for any decoded image whose longest edge is over
  960 px (longest edge 480 px, WebP quality 0.75, stepping down to keep it
  ≤ 200 KiB; JPEG on the app's background where WebP cannot be encoded) —
  also with "Orijinali gönder". The list shows `preview_url` when there is one;
  the lightbox always loads the original. With `width`/`height` the inline box
  is the picture's own shape fitted into 400×300 (never enlarged; narrower on
  a phone), reserved before the bytes arrive (`lib/imageBox.ts`); without them
  the old fixed 400×300 letterbox.

## 3. The channel's media, files and links

    GET /api/channels/{id}/attachments?kind=media|file&before=<cursor>&limit=1..100 (60)
    GET /api/channels/{id}/links?before=<cursor>&limit=1..100 (60)
      → {items, has_more, next_before}     (Bearer auth; 404 NOT_FOUND for a
        missing or voice channel; 422 INVALID_REQUEST for a bad kind, limit or cursor)

- Newest message first; within one message in its own order. The cursor is
  `"<message id>-<position>"` of the last item shown (`next_before`, null at
  the end); pass it back unchanged.
- attachments item: `{attachment: Attachment, message_id, author: User, created_at}`
  (`created_at` is the message's). `media` = png, jpeg, gif, webp, avif,
  mp4, webm video; `file` = everything else. Voice messages are in neither.
- links item: `{url, message_id, author, created_at, excerpt}` — `url` is the
  link as written in the message (the client makes the href from it with the
  same rule it uses in messages), `excerpt` the first 140 code points of the
  content.
- Links are kept in a `links` table, written in the same transaction as the
  send and the edit (an edit replaces the message's links) and removed with
  the message. At most 50 per message, each at most 2048 characters.
- **One rule for both sides.** `server/trio_server/links.py` ports
  `web/src/lib/linkify.ts`: `https?://` + no whitespace (JavaScript's `\s`) or
  `< > " ' ``` `, not right after a letter or digit, trailing sentence
  punctuation cut (brackets balanced), and what `new URL` would accept (a host,
  a numeric port ≤ 65535, no forbidden host characters, IPv6 literals, the
  WHATWG rule for hosts ending in a number). `shared/linkify-cases.json` is run
  by both test suites.
- Upgrade: the first start of this server indexes every existing message's
  links in batches of 500 (`links_backfill.done_through`); each later start
  re-indexes only messages written since (idempotent, so an interrupted run
  continues).

Client: "Medya" button in the channel header → a panel (full screen under
720 px) with tabs Medya (grid by month, "Kasım 2026", infinite scroll),
Bağlantılar (link, author, date, excerpt, "mesaja git") and Dosyalar (name,
size, author, date, download, "mesaja git"). A grid item opens a lightbox on
the original with previous/next across the whole gallery (←/→, the buttons,
a horizontal swipe), Esc closes, "mesaja git" jumps to the message (the
message family's jump, loading older pages as needed). test ids: `btn-media`,
`media-gallery`, `gallery-tab-media|links|files`, `gallery-item`,
`gallery-month`, `gallery-link`, `gallery-file`, `gallery-jump`,
`gallery-lightbox` (`data-index`), `gallery-prev`, `gallery-next`.

## 4. Voice messages

- Recorded with `MediaRecorder` from a SEPARATE `getUserMedia` (the call's
  audio graph and its sent track are never touched; a call goes on while
  recording). Type: the first of `audio/webm;codecs=opus`, `audio/webm`,
  `audio/mp4`, `audio/ogg;codecs=opus` the browser supports (Chromium 1243:
  the first three). At most 2 minutes; under 0.5 s is dropped.
- Sent as an ordinary attachment with the voice fields (§2), then by itself as
  a message with empty content.
- Server sniffing (adds to V3 §4): a WebM whose CodecIDs in its first 4 KiB are
  all `A_…` is `audio/webm`; an ISO-BMFF file whose `hdlr` boxes in its first
  4 KiB include `soun` and no `vide` is `audio/mp4`. Both are now served
  `inline`. Anything else is typed as before (the old rules read the first 64
  bytes exactly as they did).
- Client: the microphone (`btn-voice`) shows while the box is empty. Press and
  hold to record, let go to send; slide 80 px away or Esc to cancel; a short
  press records until "Gönder" (`voice-send`) or the microphone again
  (keyboard: Enter/Space starts and stops). Live time and level while
  recording. Refused microphone: a Turkish sentence. The message renders as a
  player (`voice-message`): play/pause, the 64-bar waveform as seek bar
  (click, ←/→), the time, 1× / 1,5× / 2×; one plays at a time.

## 5. Drafts and send failures

- Client: the composer's text and the reply target are kept per channel in
  `sessionStorage` (`trio.drafts`), across channel switches and reloads of the
  tab, and cleared when the message is sent. Unsent text in any channel still
  stops the reload onto a newer build (`reloadGuard` "draft").
- **`error` frames answering a `message.send` carry its `nonce`** (when the
  frame had a string nonce of at most 128 characters): every refusal —
  `INVALID_CHANNEL`, `BAD_REQUEST`, `INVALID_MESSAGE`, `INVALID_ATTACHMENT`,
  `INVALID_REPLY`, `STORAGE_FULL`, and `INTERNAL` for an unexpected failure.
  A repeated nonce is still answered with the message (V3 §10), never an
  error. Client: an error naming a pending row's nonce fails exactly that row;
  an error with no nonce falls back to the old rule (the send just made).
