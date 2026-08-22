---
name: Venom chat sessions follow the selected project
description: Switching project moves the chat session in BOTH apps, project-less sessions are never adopted, and a message is filed under the project on screen.
---

Selecting a different project — in Venom mobile or Venom Desktop — also moves
the chat: the active session becomes that project's own latest session, or
none at all when the project has never been chatted in, and the first message
then opens a session under it. Sending never appends to a session belonging to
another project, and a session with no project belongs to **no** project: it
is never listed under a project and never adopted on a switch.

**Why:** a session records the project it was created under. Both apps used to
break this differently — mobile kept the active session across a switch (the
message was filed under the *previous* project); desktop treated project-less
sessions as belonging to every project, so a message could be recorded with no
project, invisible in history and surviving the project's deletion.

Transient turn UI follows the same ownership rule on both clients: the
deliberation chamber, debate card, typing indicator, streaming bubble, and the
debate composer affordances (interject placeholder, stop control, enabled send)
render only while the conversation that started the turn is on screen. Hiding
is scoping, not teardown — the stream keeps running and the panel returns if
the reader switches back before the answer lands, while the other chat shows
its own idle state. Desktop keys its streaming state by conversation id;
mobile keeps the initiating conversation id alongside its transient state. To
prove it in a browser test, replay the SSE stream with long quiet windows and
walk to another project and back mid-turn.

**How to apply:** the project a message belongs to is the one displayed on
screen. Any new surface that opens or sends into a session (buttons, hotkeys,
send paths) must scope to the displayed project, and send paths must guard at
send time: a missing or project-mismatched active session (e.g. from a
restored/merged snapshot) starts a fresh session under the on-screen project
instead of filing into the mismatched one. Sessions stranded without a project
by the old behavior are listed nowhere once a project exists — rescuing them
is a product decision, not a merge rule.
