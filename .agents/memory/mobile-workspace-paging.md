---
name: Mobile workspace paging
description: Why Venom uses mounted, conditionally visible workspaces instead of a horizontal React Native ScrollView pager.
---

Keep Venom’s primary workspaces mounted but display only the active one, with an explicit horizontal swipe responder for navigation. Do not casually replace this with a horizontal `ScrollView` pager.

**Why:** React Native Web capped programmatic offsets at some artifact/canvas widths, leaving two workspaces visible side-by-side even when every child declared the viewport width. Repeated flex and width adjustments did not make that behavior reliable.

**How to apply:** Preserve local screen state by keeping every workspace mounted, hide inactive screens with layout styles, and route deliberate horizontal swipes through the active tab state. Let the ontology screen reserve drag gestures for graph orbiting.