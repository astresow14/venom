---
name: Venom chat file exchange
description: SSE file-authoring contract, fail-open render failures, single-voice rule, upload/download transport quirks, image attachments/vision gating, dictation transcribe contract, and merge survival for message attachments.
---

# Venom chat file exchange

## Single-voice rule (product decision)
A file-producing request never runs multi-voice verify/debate — exactly one
model authors the document. The server announces the override in-stream
(`filePlan.switchedFrom`), and both clients surface it on the writing card
("<Mode> stepped aside — a single voice authors a file").
**Why:** the user chose this explicitly; a debate over a document produces
committee prose and doubles cost.
**How to apply:** any new response mode must yield to file mode at the intent
gate, and the yield must stay visible in the stream, never silent.

## SSE contract rides the respond stream
`filePlan {format,title,switchedFrom?}` arrives on the initial event beside
modelId/modelName; `fileProgress {chars}` ticks; `file {id,...}` lands before
`done`. None of these branches return early in client SSE loops — attribution
and content can share an event with file fields.

## Render failure fails open
`error {code:"file_render_failed"}` arrives AFTER the content and is followed
by `done:true`. Clients keep the streamed answer, clear the writing card, and
announce the miss after the turn persists (desktop toast, mobile Alert —
Alert.alert is a no-op on RN Web and that matched existing app precedent).
Treating it like other stream errors would erase a good answer.

## Transport quirks
- Upload is ticket → raw PUT of bytes → complete. Download is a raw fetch
  with the auth header — the generated client mangles binary bodies (it
  resolves error bodies and types responses as JSON).
- Mobile: expo-file-system v19 `File` API (`new File(uri).bytes()` async,
  `File.write` sync, `Paths.cache`); native delivery goes through
  expo-sharing's share sheet; web uses a blob anchor.
- pdf-lib standard fonts are WinAnsi-only: sanitize/transliterate model text
  before drawing or `drawText` throws on characters like — or emoji, which is
  exactly the render-failure path.

## Hardening lessons (from review)
- **Seal uploads at complete.** The signed PUT URL stays valid for its TTL
  and is reusable, so serving the ticket path lets a ticket holder rewrite
  content after verification. Complete downloads the bytes, extracts, then
  copies exactly those bytes to a fresh object path and marks ready with
  that sealed path + byte length; downloads only read the sealed copy. An
  integration test PUTs junk to the ticket path after ready and asserts the
  download is unchanged.
- **Bound PDF extraction.** Whole-document text extraction expands a
  compressed bomb before any post-hoc character slice can help. Walk pages
  (hard page cap, early exit once the char cap is covered) and free the
  parser after — unpdf's proxy type omits `destroy`, so feature-detect it
  with a structural cast.
- **History must keep attachment ids.** Both clients forward
  `attachmentIds` on PRIOR user messages in the request history, not just
  the newly composed one — otherwise file conversations go amnesiac after
  one turn and cross-device file chats diverge. Regression e2e asserts the
  second request still carries the first turn's ids.

## Attachments survive merges as whole messages
Both apps merge conversation messages as whole objects (id union, newest
conversation wins per message id) — `attachments` ride along untouched,
including the optional image `thumbnail` data-URL on stamps.
Unit tests on both apps pin this. If message merging ever becomes
field-level, attachments must be carried explicitly or they vanish
(see venom-workspace-schema-extensions).

## Image attachments and vision (added with the images feature)
- Images reuse the same ticket → PUT → complete handshake as documents;
  messages carry only `attachmentIds` + display stamps. The respond route
  re-reads image bytes server-side for the LATEST user message only; older
  image attachments degrade to name-only notes.
  **Why:** re-sending every historical image would blow request budgets and
  provider token costs on long chats; the newest turn is where the question
  about the image lives.
- The vision gate lives in the one funnel all modes pass through
  (`streamVenomResponse`): vision-capable models get native multimodal
  payloads; others get `replaceImagesWithNotes` — an explicit "you cannot
  view images, say so plainly" note. Never silently drop images.
- Type-policy traps: `jpg`/`jpeg` must alias to one stored `image/jpeg`
  (pickers claim `image/jpg` too); mobile pickers report octet-stream for
  images, so extension decides; extension/claimed-type disagreement is
  rejected (`run.exe` claiming image/png stays out).
- The OpenAI SDK's chat message type needs a discriminated union per role
  once user content becomes parts (`string | parts` for user; assistant and
  system stay string-only) or TS overload resolution fails on the request.
- expo-image-manipulator's `saveAsync({ base64: true })` returns bare
  base64 WITHOUT the `data:` prefix — prepend it manually or thumbnails
  are invisible.

## Desktop dictation transcribe contract
The composer mic posts `{audioBase64}` only to the existing voice
transcribe endpoint — there is no `format`/mimeType field in the generated
zod schema; the server sniffs the audio container. Don't add a client-side
format field; pick the recorder mimeType via `MediaRecorder.isTypeSupported`
candidates and let the server sort out the container.
