---
name: Clerk getToken in effect deps
description: getToken from useAuth is not render-stable; effects depending on it can loop or re-poll every render.
---

# Clerk `getToken` must not sit in effect dependency arrays

**The rule:** Never put `getToken` from Clerk's `useAuth()` (Expo or web) in a `useEffect`/`useCallback` dependency list that gates fetching or state writes. Read it through a ref (`ref.current()`), updated by a tiny `useEffect([getToken])`.

**Why:** On Expo web, `getToken`'s identity can change on any render. An effect depending on it re-runs per render: unconditional state writes become "Maximum update depth exceeded" loops (worst when the effect lives in an app-wide context), and gated fetches become silent re-poll storms.

**How to apply:**
- Pattern: `const tokenRef = useRef(getToken); useEffect(() => { tokenRef.current = getToken; }, [getToken]);` then `await tokenRef.current()` inside the effect, with `getToken` removed from the fetch effect's deps.
- Give state writes in re-runnable effects same-reference bailouts (`set(cur => unchanged ? cur : next)`) so dep churn from any source cannot feed a loop.
- Event handlers may call `getToken()` directly — only effects are at risk.
