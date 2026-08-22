---
name: Venom speaker avatars
description: Debate/verify avatar rules — model-voice vs persona-monogram decision, cross-app glyph parity, and run grouping direction per app.
---

# Venom speaker avatars

Both chat apps render group-chat avatars for multi-voice turns via a `SpeakerAvatar` component (mobile: `components/chat/`, desktop: `src/components/workspace/`).

**Voice-kind rule:** a turn is a *model voice* iff `modelId` is present AND (`speakerId` is absent OR `speakerId === modelId`) — then it gets the model family glyph from the already-fetched catalog (unknown family → Venom mark). Everything else (debate personas, ALL verify voices — their voiceIds are `direct`/`skeptic`/`evidence`, never model ids) gets a monogram of the voice name.
**Why:** persona turns carry the underlying `modelId` too, so `modelId` presence alone cannot distinguish them; and three identical model glyphs would say nothing. Text labels distinguish models; avatars distinguish voices.
**How to apply:** never key avatar choice on `modelId` alone; reuse `speakerGlyph()` rather than reimplementing the rule at a new call site.

**Cross-app parity:** the glyph path data (`MODEL_FAMILY_GLYPHS`, 24×24 hand-drawn paths) is duplicated per app and must stay byte-identical — same KEEP IN SYNC pattern as the voice modules. Test ids follow `speaker-avatar-<gpt|claude|gemini|grok|monogram-<initials>|mark>` in both apps.

**Run grouping:** avatar + name chip sit on a run's chronologically FIRST message only. Mobile's list is inverted (newest-first), so the chronological predecessor is `messages[index + 1]`; desktop maps oldest→newest and uses `index - 1`. Continuation rows keep the fixed-width gutter (mobile) / left padding (desktop) so bubbles stay aligned, and pull tighter via a grouped margin override.

Avatars are decorative (`aria-hidden` / `accessibilityElementsHidden`) because the speaker name is always adjacent visible text.
