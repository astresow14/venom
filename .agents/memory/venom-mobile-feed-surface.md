---
name: Venom mobile feed surface
description: The mobile Feed tab renders CommunityBriefing; FeedWorkspace in index.tsx is unmounted dead code
---

The mobile Feed tab mounts `CommunityBriefing`; the `FeedWorkspace` component inside `app/index.tsx` is dead code left from a feed redesign and never renders.

**Why:** Feed UI added to the dead component typechecks and reads as complete but never appears at runtime; only exercising the live tab exposes the miss.

**How to apply:** Put feed-surface UI in CommunityBriefing (its list header renders above the thread). Before extending any component, confirm it is actually mounted somewhere, and verify feed features against the running Feed tab rather than by reading source.
