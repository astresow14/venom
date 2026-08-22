import type { VenomMessageDeliberation } from "@workspace/api-client-react";
import type {
  DeliberationRosterVoice,
  DeliberationTakeState,
  LocalDeliberation,
} from "@/components/chat/chatTypes";

/**
 * Verify-mode (deliberation) SSE events, isolated from the other response
 * modes: roster metadata, the final persisted summary, stage moves, and
 * per-voice chunks. The handler owns the deliberation accumulators for one
 * send. `handleEvent` returns true only for voice chunks — those feed the
 * transient panel, never the main answer — while roster/summary/stage events
 * deliberately fall through so attribution or content can ride the same
 * event, exactly as the protocol allows.
 */
export function createDeliberationStreamHandler(deps: {
  /** Mirrors the live chamber into transient UI state. */
  publish: (snapshot: LocalDeliberation) => void;
  setShowTyping: (value: boolean) => void;
}) {
  let roster: DeliberationRosterVoice[] | null = null;
  let takes: Record<string, DeliberationTakeState> = {};
  let stage: "voices" | "synthesis" = "voices";
  let finalDeliberation: VenomMessageDeliberation | null = null;

  const sync = () => {
    if (!roster) return;
    deps.publish({
      roster,
      stage,
      takes: Object.fromEntries(
        Object.entries(takes).map(([voiceId, take]) => [
          voiceId,
          { ...take },
        ]),
      ),
    });
  };

  return {
    handleEvent(parsed: any): boolean {
      if (parsed.deliberation?.voices) {
        if (Array.isArray(parsed.deliberation.disagreements)) {
          finalDeliberation = {
            voices: parsed.deliberation.voices,
            disagreements: parsed.deliberation.disagreements,
          } as VenomMessageDeliberation;
          for (const take of finalDeliberation.voices) {
            takes[take.voiceId] = {
              content: take.content,
              status: take.status === "failed" ? "failed" : "ok",
            };
          }
          sync();
        } else {
          roster = parsed.deliberation.voices as DeliberationRosterVoice[];
          takes = Object.fromEntries(
            roster.map((voice) => [
              voice.voiceId,
              { content: "", status: "streaming" as const },
            ]),
          );
          stage = "voices";
          deps.setShowTyping(false);
          sync();
        }
      }
      if (parsed.stage === "synthesis" && roster) {
        stage = "synthesis";
        sync();
      }
      if (typeof parsed.voice === "string") {
        // Voice chunks feed the transient panel, never the main answer.
        const take = takes[parsed.voice] ?? {
          content: "",
          status: "streaming" as const,
        };
        takes[parsed.voice] = take;
        if (parsed.content) take.content += parsed.content;
        if (parsed.voiceStatus === "ok" || parsed.voiceStatus === "failed") {
          take.status = parsed.voiceStatus;
        }
        sync();
        return true;
      }
      return false;
    },
    /**
     * What the persisted message should carry: the takes and disagreements
     * alongside the collective answer. If the final summary event never
     * arrived, fall back to what accumulated while streaming; null when this
     * turn never deliberated.
     */
    persistedDeliberation(): VenomMessageDeliberation | null {
      if (finalDeliberation) return finalDeliberation;
      if (!roster) return null;
      return {
        voices: roster.map((voice) => {
          const take = takes[voice.voiceId];
          return {
            voiceId: voice.voiceId,
            name: voice.name,
            ...(voice.modelId ? { modelId: voice.modelId } : {}),
            ...(voice.modelName ? { modelName: voice.modelName } : {}),
            content: (take?.content ?? "").slice(0, 8000),
            status:
              take?.status === "failed"
                ? ("failed" as const)
                : ("ok" as const),
          };
        }),
        disagreements: [],
      } as VenomMessageDeliberation;
    },
  };
}

export type DeliberationStreamHandler = ReturnType<
  typeof createDeliberationStreamHandler
>;
