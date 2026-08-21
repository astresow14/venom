---
name: Venom chat sessions follow the selected project
description: Switching project moves the chat session, so a message is filed under the project on screen — and what that means for sync checks.
---

Selecting a different project in Venom mobile also moves the chat: the active
session becomes that project's own latest session, or none at all when the
project has never been chatted in, and the first message then opens a session
under it. Sending never appends to a session belonging to another project.

**Why:** a session records the project it was created under, and the mobile app
used to keep the active session across a project switch. A message typed right
after creating a project was therefore filed under the *previous* project — the
answer looked right on screen but the synced workspace recorded it elsewhere,
and deleting the project it was written in left the message behind.

**How to apply:** the project a message belongs to is the one displayed, which
is the explicitly selected project or the fallback first project when none is
selected — keep those two in step when adding any new place that opens a
session. Cloud-snapshot checks may now scope conversations by `projectId`.
Beware a restored or merged snapshot whose active session and active project
disagree: sending starts a fresh session rather than filing into the mismatched
one.
