/**
 * VoiceOrb.tsx — the living black mass at the center of voice mode.
 *
 * A slowly morphing blob of near-black material with a faint white rim: the
 * symbiote listening. Mic and playback levels arrive as plain mutable refs
 * (written by the audio adapter ~30×/s) and are read here by a rAF loop that
 * drives scale and halo directly on the DOM — no React re-renders per frame.
 *
 * Phases shade the motion: breathing while listening, a tighter faster pulse
 * while thinking, a fuller sway while speaking, still and dimmed on error.
 * Under `prefers-reduced-motion` all continuous animation stops; phase is
 * conveyed by opacity alone and the status line carries the rest.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { VoicePhase } from '@/hooks/useVoiceConversation';

type VoiceOrbProps = {
  phase: VoicePhase;
  inputLevelRef: React.MutableRefObject<number>;
  outputLevelRef: React.MutableRefObject<number>;
  size?: number;
};

/** Injected once; keyframes for the organic border-radius morph. */
const ORB_CSS = `
@keyframes venom-voice-morph {
  0%   { border-radius: 46% 54% 52% 48% / 52% 46% 54% 48%; }
  25%  { border-radius: 54% 46% 44% 56% / 48% 54% 46% 52%; }
  50%  { border-radius: 48% 52% 56% 44% / 54% 48% 52% 46%; }
  75%  { border-radius: 52% 48% 46% 54% / 46% 52% 48% 54%; }
  100% { border-radius: 46% 54% 52% 48% / 52% 46% 54% 48%; }
}
@keyframes venom-voice-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.035); }
}
@media (prefers-reduced-motion: reduce) {
  .venom-voice-mass { animation: none !important; border-radius: 50% !important; }
  .venom-voice-breather { animation: none !important; }
}
`;

/** Per-phase motion character: morph speed, breathe speed, resting opacity. */
const PHASE_STYLE: Record<
  VoicePhase,
  { morphDur: string; breatheDur: string; opacity: number }
> = {
  idle: { morphDur: '14s', breatheDur: '9s', opacity: 0.7 },
  connecting: { morphDur: '12s', breatheDur: '7s', opacity: 0.8 },
  listening: { morphDur: '9s', breatheDur: '5.5s', opacity: 1 },
  transcribing: { morphDur: '7s', breatheDur: '4.5s', opacity: 0.92 },
  thinking: { morphDur: '4.5s', breatheDur: '2.6s', opacity: 0.96 },
  speaking: { morphDur: '3.2s', breatheDur: '3.4s', opacity: 1 },
  error: { morphDur: '0s', breatheDur: '0s', opacity: 0.45 },
};

export function VoiceOrb({
  phase,
  inputLevelRef,
  outputLevelRef,
  size = 190,
}: VoiceOrbProps) {
  const massRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);

  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // Level-driven scale + halo, straight onto the DOM. The refs mutate ~30×/s;
  // a lerp keeps the mass feeling like heavy liquid rather than a VU meter.
  useEffect(() => {
    if (reducedMotion) return undefined;
    let raf = 0;
    let current = 1;
    const tick = () => {
      const input = inputLevelRef.current;
      const output = outputLevelRef.current;
      const target = 1 + Math.min(0.24, input * 0.16 + output * 0.22);
      current += (target - current) * 0.16;
      if (massRef.current) {
        massRef.current.style.transform = `scale(${current.toFixed(4)})`;
      }
      if (haloRef.current) {
        const glow = Math.min(0.55, 0.1 + input * 0.3 + output * 0.5);
        haloRef.current.style.opacity = glow.toFixed(3);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inputLevelRef, outputLevelRef, reducedMotion]);

  const style = PHASE_STYLE[phase];

  return (
    <div
      aria-hidden="true"
      className="relative isolate"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line react/no-danger -- static keyframes */}
      <style dangerouslySetInnerHTML={{ __html: ORB_CSS }} />
      {/* Halo — the one glow this screen is allowed. White only. */}
      <div
        ref={haloRef}
        className="absolute -inset-6 -z-10 rounded-full transition-opacity duration-300"
        style={{
          background:
            'radial-gradient(circle, rgba(245,245,242,0.28) 0%, rgba(245,245,242,0.07) 45%, transparent 70%)',
          opacity: phase === 'error' ? 0 : 0.1,
          filter: 'blur(6px)',
        }}
      />
      {/* Outer breathe wrapper (scale animation must not fight the rAF scale,
          so the two live on different elements). */}
      <div
        className="venom-voice-breather h-full w-full"
        style={{
          animation:
            style.breatheDur === '0s'
              ? 'none'
              : `venom-voice-breathe ${style.breatheDur} ease-in-out infinite`,
        }}
      >
        {/* The mass itself. */}
        <div
          ref={massRef}
          className="venom-voice-mass h-full w-full transition-opacity duration-500"
          style={{
            opacity: style.opacity,
            background:
              'radial-gradient(circle at 32% 26%, #262626 0%, #101010 42%, #050505 78%)',
            border: '1px solid rgba(245,245,242,0.16)',
            boxShadow:
              'inset 0 1px 1px rgba(245,245,242,0.18), inset 0 -18px 32px rgba(0,0,0,0.85), 0 18px 48px rgba(0,0,0,0.6)',
            animation:
              style.morphDur === '0s'
                ? 'none'
                : `venom-voice-morph ${style.morphDur} ease-in-out infinite`,
            borderRadius: '46% 54% 52% 48% / 52% 46% 54% 48%',
            willChange: 'transform, border-radius',
          }}
        >
          {/* Specular sheen — the wet-material highlight. */}
          <div
            className="absolute left-[22%] top-[16%] h-[26%] w-[34%] rounded-full"
            style={{
              background:
                'radial-gradient(ellipse at center, rgba(245,245,242,0.2) 0%, transparent 70%)',
              filter: 'blur(5px)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
