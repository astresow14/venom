---
name: Venom pan-gesture surfaces
description: PanResponder rules for drag surfaces (blend pad) living inside the mobile workspace pager
---

Rules for any PanResponder drag surface in the Venom mobile app (blend pad today):

- **Commit from the event's own coordinates, never `gesture.moveX/moveY`.** Those gesture-state fields stay `(0, 0)` until the first move event, so a stationary tap "releases at the screen origin" and commits a point the finger never touched. `event.nativeEvent.pageX/pageY` is valid on grant, move, and release, on both native and react-native-web.
- **Why:** browser tests that only click buttons never exercise this; the bug only shows on tap-to-place.

- **Refuse responder termination on drag surfaces.** The workspace pager claims mostly-horizontal moves (`|dx| > 18 && |dx| > 1.5|dy|`) anywhere in the chat workspace. Without `onPanResponderTerminationRequest: () => false` a drag toward a side corner is stolen mid-gesture and can swipe tabs. Keep `onShouldBlockNativeResponder: () => true` for Android native containers.

- **Queue points that beat `measureInWindow`.** The origin measurement is async (a macrotask on web); a fast tap's release can arrive before it. Stash the newest `{point, commit}` and let the measure callback replay it, otherwise the commit is silently dropped. Re-measure per grant so scroll/keyboard layout shifts between gestures stay correct.

- **Haptics on every commit path.** If buttons tick (`Haptics.selectionAsync`), the drag-release commit must tick too; keep system-initiated `onPanResponderTerminate` settles silent.

**How to apply:** any new draggable control inside the workspace pager (sliders, reorder handles, future pads) needs all four; the RNW responder system reproduces the tap and steal bugs, so pin them with Playwright mouse tests (down → move steps → up) computing targets from the live bounding box.
