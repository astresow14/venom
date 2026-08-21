/**
 * useVoiceSample.ts — tap-to-hear previews for the named voice presets.
 *
 * Streams one short sample line through /venom/voice/speak into the same
 * platform audio adapter voice mode uses. Only one sample plays at a time;
 * tapping the playing preset again stops it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/expo";
import { fetch as expoFetch } from "expo/fetch";

import { IS_UI_TEST, type VenomVoicePresetId } from "@/context/VenomContext";
import { createSseLineReader } from "@/context/voiceSpeech";
import { getVoiceAudioAdapter, type VoicePlaybackHandle } from "@/audio";

const UI_TEST_CHAT_TOKEN = "venom-ui-test-chat-token";

export type VoiceSampleController = {
  previewingId: VenomVoicePresetId | null;
  sampleError: string | null;
  playSample: (presetId: VenomVoicePresetId, sampleText: string) => void;
  stopSample: () => void;
};

export function useVoiceSample(): VoiceSampleController {
  const { getToken } = useAuth();
  const [previewingId, setPreviewingId] = useState<VenomVoicePresetId | null>(
    null,
  );
  const [sampleError, setSampleError] = useState<string | null>(null);
  const playbackRef = useRef<VoicePlaybackHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(0);

  const stopSample = useCallback(() => {
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPreviewingId(null);
  }, []);

  const playSample = useCallback(
    (presetId: VenomVoicePresetId, sampleText: string) => {
      if (previewingId === presetId) {
        stopSample();
        return;
      }
      stopSample();
      setSampleError(null);
      const sessionId = sessionRef.current;
      setPreviewingId(presetId);

      void (async () => {
        try {
          const domain = process.env.EXPO_PUBLIC_DOMAIN;
          if (!domain) throw new Error("API domain is unavailable");
          const token = IS_UI_TEST ? UI_TEST_CHAT_TOKEN : await getToken();
          if (!token) throw new Error("Not signed in");
          if (sessionRef.current !== sessionId) return;

          const adapter = getVoiceAudioAdapter();
          const support = adapter.isSupported();
          if (!support.supported) throw new Error(support.reason);

          let finishedOrFailed = false;
          const playback = adapter.createPlayback((event) => {
            if (sessionRef.current !== sessionId) return;
            if (event.type === "finished" || event.type === "error") {
              finishedOrFailed = true;
              setPreviewingId((current) =>
                current === presetId ? null : current,
              );
            }
          });
          playbackRef.current = playback;

          const controller = new AbortController();
          abortRef.current = controller;
          const response = await expoFetch(
            `https://${domain}/api/venom/voice/speak`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                text: sampleText.slice(0, 2000),
                presetId,
              }),
              signal: controller.signal,
            },
          );
          if (response.status === 503) {
            throw new Error("Voice is not configured right now.");
          }
          if (!response.ok) {
            throw new Error("The sample could not be played.");
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("The sample could not be played.");

          const decoder = new TextDecoder();
          let begun = false;
          let sawError = false;
          const sse = createSseLineReader((payload) => {
            if (payload === "[DONE]") return;
            try {
              const parsed = JSON.parse(payload) as {
                format?: { sampleRate?: number };
                audio?: string;
                error?: string;
              };
              if (parsed.format && !begun) {
                begun = true;
                playback.begin({
                  sampleRate: parsed.format.sampleRate ?? 24_000,
                });
              }
              if (parsed.audio && begun) playback.enqueueChunk(parsed.audio);
              if (parsed.error) sawError = true;
            } catch {
              // Malformed events surface as missing audio below.
            }
          });
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (sessionRef.current !== sessionId) {
              await reader.cancel();
              return;
            }
            sse.push(decoder.decode(value, { stream: true }));
          }
          sse.end();
          if (sawError || !begun) {
            throw new Error("The sample could not be played.");
          }
          playback.end();
          if (finishedOrFailed && sessionRef.current === sessionId) {
            setPreviewingId((current) =>
              current === presetId ? null : current,
            );
          }
        } catch (error) {
          if (sessionRef.current !== sessionId) return;
          if ((error as Error | null)?.name === "AbortError") return;
          playbackRef.current?.stop();
          playbackRef.current = null;
          setSampleError(
            error instanceof Error
              ? error.message
              : "The sample could not be played.",
          );
          setPreviewingId((current) =>
            current === presetId ? null : current,
          );
        }
      })();
    },
    [getToken, previewingId, stopSample],
  );

  useEffect(() => stopSample, [stopSample]);

  return { previewingId, sampleError, playSample, stopSample };
}
