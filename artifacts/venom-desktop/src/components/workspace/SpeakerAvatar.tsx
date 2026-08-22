import { cn } from "@/lib/utils";
import { VenomMark } from "@/components/venom-mark";

/**
 * Group-chat avatars for multi-voice turns (Debate and Verify): a small
 * monochrome circular badge that makes it instantly obvious who is talking,
 * the way an iMessage group chat does.
 *
 * A voice that IS a model (models-mode debates seat the model itself, so the
 * roster's voice id equals the model id) wears its model family's glyph. A
 * persona voice (its own id — skeptic, direct, … — riding some model) wears a
 * monogram of its name instead, so three personas on one model never render
 * as three identical model marks. This mirrors the existing rule that model
 * labels only appear when more than one distinct model is involved. Unknown
 * or absent families fall back to the Venom mark.
 *
 * KEEP IN SYNC: the glyph paths and the voice→glyph decision are mirrored in
 * the mobile app at artifacts/venom/components/chat/SpeakerAvatar.tsx — edit
 * both together (same cross-app parity pattern as VENOM_MARK_PATH).
 */

export type ModelFamilyKey = "GPT" | "Claude" | "Gemini" | "Grok";

// Hand-drawn 24×24 marks — original geometric interpretations of each family
// (never traced logo art): a six-blade pinwheel knot for GPT, a twelve-ray
// starburst for Claude, a four-point sparkle for Gemini, and a broken slash
// for Grok. Generated numerically; treat the strings as opaque constants.
export const MODEL_FAMILY_GLYPHS: Record<ModelFamilyKey, string> = {
  GPT: "M12.5 10.37 L20.51 7.65 A1.55 1.55 0 0 1 19.51 4.71 L11.5 7.43 A1.55 1.55 0 0 1 12.5 10.37 Z M13.66 11.62 L20.02 17.19 A1.55 1.55 0 0 1 22.07 14.86 L15.71 9.28 A1.55 1.55 0 0 1 13.66 11.62 Z M13.16 13.25 L11.51 21.54 A1.55 1.55 0 0 1 14.56 22.15 L16.2 13.85 A1.55 1.55 0 0 1 13.16 13.25 Z M11.5 13.63 L3.49 16.35 A1.55 1.55 0 0 1 4.49 19.29 L12.5 16.57 A1.55 1.55 0 0 1 11.5 13.63 Z M10.34 12.38 L3.98 6.81 A1.55 1.55 0 0 1 1.93 9.14 L8.29 14.72 A1.55 1.55 0 0 1 10.34 12.38 Z M10.84 10.75 L12.49 2.46 A1.55 1.55 0 0 1 9.44 1.85 L7.8 10.15 A1.55 1.55 0 0 1 10.84 10.75 Z",
  Claude:
    "M11.55 9.14 L11.51 1.11 L12.49 1.11 L12.45 9.14 Z M13.04 9.29 L15.82 4.63 L16.47 5.01 L13.83 9.75 Z M14.25 10.17 L21.18 6.13 L21.68 6.98 L14.71 10.96 Z M14.86 11.55 L20.29 11.62 L20.29 12.38 L14.86 12.45 Z M14.71 13.04 L21.68 17.02 L21.18 17.87 L14.25 13.83 Z M13.83 14.25 L16.47 18.99 L15.82 19.37 L13.04 14.71 Z M12.45 14.86 L12.49 22.89 L11.51 22.89 L11.55 14.86 Z M10.96 14.71 L8.18 19.37 L7.53 18.99 L10.17 14.25 Z M9.75 13.83 L2.82 17.87 L2.32 17.02 L9.29 13.04 Z M9.14 12.45 L3.71 12.38 L3.71 11.62 L9.14 11.55 Z M9.29 10.96 L2.32 6.98 L2.82 6.13 L9.75 10.17 Z M10.17 9.75 L7.53 5.01 L8.18 4.63 L10.96 9.29 Z",
  Gemini:
    "M12 1.8 C12.85 7.4, 16.6 11.15, 22.2 12 C16.6 12.85, 12.85 16.6, 12 22.2 C11.15 16.6, 7.4 12.85, 1.8 12 C7.4 11.15, 11.15 7.4, 12 1.8 Z",
  Grok: "M3.99 4.22 L17.99 21.42 L20.01 19.78 L6.01 2.58 Z M17.99 2.58 L12.74 9.03 L14.76 10.67 L20.01 4.22 Z M9.24 13.33 L3.99 19.78 L6.01 21.42 L11.26 14.97 Z",
};

export type SpeakerGlyph =
  | { kind: "family"; family: ModelFamilyKey }
  | { kind: "monogram"; letters: string }
  | { kind: "mark" };

/** Uppercase initials of up to two words: "Skeptic" → "S", "First take" → "FT". */
export function monogramFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export type FamilyForModel = (modelId: string) => string | undefined;

export function speakerGlyph(input: {
  /** The voice's own id: a roster voiceId or a persisted message speakerId. */
  speakerId?: string | null;
  modelId?: string | null;
  name: string;
  /** Resolves a model id to its family via the already-fetched catalog. */
  familyForModel: FamilyForModel;
}): SpeakerGlyph {
  const { speakerId, modelId, name, familyForModel } = input;
  // The voice IS the model exactly when the ids agree (or no separate voice
  // id exists at all). Persona turns always carry the underlying modelId too,
  // so modelId presence alone would wrongly dress every persona as its model.
  const isModelVoice =
    Boolean(modelId) && (!speakerId || speakerId === modelId);
  if (isModelVoice && modelId) {
    const family = familyForModel(modelId);
    if (family && family in MODEL_FAMILY_GLYPHS) {
      return { kind: "family", family: family as ModelFamilyKey };
    }
    return { kind: "mark" };
  }
  const letters = monogramFor(name);
  return letters ? { kind: "monogram", letters } : { kind: "mark" };
}

/** Stable per-glyph key used for testids: gpt | claude | monogram-ft | mark. */
export function speakerGlyphKey(glyph: SpeakerGlyph): string {
  if (glyph.kind === "family") return glyph.family.toLowerCase();
  if (glyph.kind === "monogram")
    return `monogram-${glyph.letters.toLowerCase()}`;
  return "mark";
}

const SIZE_CLASSES = {
  sm: { badge: "h-5 w-5", glyph: "h-3 w-3", text: "text-[8px]" },
  md: { badge: "h-6 w-6", glyph: "h-3.5 w-3.5", text: "text-[9px]" },
} as const;

/**
 * The badge itself. Always decorative: every render site keeps the speaker's
 * name as adjacent visible text, so the avatar is aria-hidden.
 */
export function SpeakerAvatar({
  glyph,
  size = "md",
  className,
}: {
  glyph: SpeakerGlyph;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  const sizes = SIZE_CLASSES[size];
  return (
    <span
      aria-hidden="true"
      data-testid={`speaker-avatar-${speakerGlyphKey(glyph)}`}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-foreground text-background",
        sizes.badge,
        className,
      )}
    >
      {glyph.kind === "monogram" ? (
        <span
          className={cn("font-semibold leading-none tracking-wide", sizes.text)}
        >
          {glyph.letters}
        </span>
      ) : glyph.kind === "family" ? (
        <svg
          viewBox="0 0 24 24"
          className={sizes.glyph}
          focusable="false"
          aria-hidden="true"
        >
          <path
            d={MODEL_FAMILY_GLYPHS[glyph.family]}
            fill="currentColor"
            fillRule="evenodd"
          />
        </svg>
      ) : (
        <VenomMark className={sizes.glyph} />
      )}
    </span>
  );
}
