import { useEffect, useRef, useState } from "react";
import {
  createAdaptiveQuality,
  createEmptyField,
  createSlimeLife,
  createSlimePointer,
  createSlimeRenderer,
  packSlimeField,
  slimeCapacityForTierName,
  SLIME_POINTER_TENDRIL_DROPS,
  type AdaptiveQuality,
  type SlimeField,
  type SlimePointerTarget,
  type SlimeRenderer,
  type SlimeStyle,
} from "@workspace/slime";
import { createLandingOrganism } from "@/components/landing-organism";
import { IS_UI_TEST } from "@/lib/ui-test";

/**
 * Test hook: `?slimeTier=full` pins the renderer tier so captures can show
 * the whole organism on software rasterizers that live rendering would
 * (correctly) tier down. Inert outside UI-test builds.
 */
function capacityOverrideFromLocation() {
  if (!IS_UI_TEST || typeof window === "undefined") return null;
  const tier = new URLSearchParams(window.location.search).get("slimeTier");
  return tier ? slimeCapacityForTierName(tier) : null;
}

/**
 * Test hook: `?slimeScale=0.8` pins the render scale and turns adaptation
 * off, so visual captures stay deterministic instead of rendering at
 * whatever resolution the rasterizer earned. Inert outside UI-test builds.
 */
function scaleOverrideFromLocation(): number | null {
  if (!IS_UI_TEST || typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("slimeScale");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 2) : null;
}

/** Live adaptation counters, published on `window` for browser tests only. */
type LandingSlimeTelemetry = {
  pinned: boolean;
  scale: number;
  initialScale: number;
  minScale: number;
  maxScale: number;
  frames: number;
  changes: number;
  bufferWidth: number;
  bufferHeight: number;
  /** The capacity tier this context actually compiled. */
  capacity: { blobs: number; links: number; drops: number };
  /** Droplets packed into the most recently rendered frame. */
  dropCount: number;
  /** Eased pointer-attractor state, straight from the engine module. */
  pointerWeight: number;
  /** Nodes inside the pointer's influence on the last frame. */
  pointerTouched: number;
  /** Whether reduced motion froze this frame. */
  frozen: boolean;
  /**
   * Order-weighted sum over the packed field. Two frames with the same
   * checksum drew the same geometry — the reduced-motion stillness proof.
   */
  fieldChecksum: number;
  /** Largest packed blob radius, in CSS pixels (scale divided back out). */
  maxBlobRadius: number;
};

declare global {
  interface Window {
    __venomLandingSlime?: LandingSlimeTelemetry;
  }
}

const STYLE: SlimeStyle = {
  ink: [0.02, 0.02, 0.024],
  light: [1, 1, 1],
  alpha: 0.95,
  blend: 30,
};

/** Adaptation never sheds below this — past it, blur reads as a bug. */
const MIN_RENDER_SCALE = 0.3;

/** Sharpening may reach device resolution, capped: DPR 3 is 9x the shading. */
function maxRenderScale() {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.max(MIN_RENDER_SCALE, Math.min(dpr, 1.5));
}

/**
 * The starting render scale, kept well below the device pixel ratio.
 * Raymarching costs per pixel; the measured cadence sheds or sharpens from
 * this opening guess exactly like the knowledge-map host.
 */
function initialRenderScale(width: number) {
  const budget = width < 768 ? 0.62 : 0.78;
  return Math.max(0.4, maxRenderScale() * budget);
}

/**
 * The living symbiote backdrop behind the signed-out landing hero.
 *
 * An ambient organism (mass weighted into the stage edges, hero column kept
 * near-black) breathes and roams on its own; the engine's pointer attractor
 * makes it swell, lean and reach toward the cursor, and touch acts as a
 * momentary attractor. The canvas is pointer-inert and sits behind the
 * page's own content, so typing, clicking and keyboard navigation are
 * untouched.
 *
 * Rendering happens entirely from refs and window listeners so React never
 * tears down the GL context. If WebGL is unavailable or the program fails
 * to build, the canvas quietly stays empty (and fully transparent) and the
 * landing page keeps its clean black background. Under reduced motion the
 * sculpture is present but perfectly still: the organism clock pins to 0
 * and the attractor is inert.
 *
 * Default export so the landing page can lazy-load the whole GL stack off
 * the first-paint critical path.
 */
export default function LandingSlime() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Fade the layer in only after it has actually drawn a frame, so slow
  // devices never watch the backdrop assemble itself.
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = (canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      depth: false,
      powerPreference: "low-power",
    }) ??
      canvas.getContext("experimental-webgl", {
        alpha: true,
      })) as WebGLRenderingContext | null;

    if (!gl) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const organism = createLandingOrganism();
    // Droplet life and the pointer reaction survive context loss on
    // purpose: a rebuilt program resumes mid-motion instead of resetting.
    const life = createSlimeLife();
    const pointer = createSlimePointer();

    const pinnedScale = scaleOverrideFromLocation();

    let renderer: SlimeRenderer | null = null;
    let field: SlimeField | null = null;
    let quality: AdaptiveQuality | null = null;
    let telemetry: LandingSlimeTelemetry | null = null;
    let frame = 0;
    let scale = 1;
    let disposed = false;
    let shown = false;

    // ── Pointer tracking ────────────────────────────────────────────────
    // One mutable target object, written by window-level listeners and read
    // by the draw loop. The canvas itself stays pointer-inert; the page
    // above owns every real interaction.
    const point: SlimePointerTarget = { x: 0, y: 0, pressed: false };
    const pointerState: { target: SlimePointerTarget | null } = {
      target: null,
    };
    let surfaceLeft = 0;
    let surfaceTop = 0;

    const refreshSurfaceOffset = () => {
      const rect = canvas.getBoundingClientRect();
      surfaceLeft = rect.left;
      surfaceTop = rect.top;
    };

    const setFromEvent = (event: PointerEvent, pressed: boolean | null) => {
      if (!event.isPrimary) return;
      point.x = event.clientX - surfaceLeft;
      point.y = event.clientY - surfaceTop;
      if (pressed !== null) point.pressed = pressed;
      pointerState.target = point;
    };

    const handlePointerMove = (event: PointerEvent) => setFromEvent(event, null);
    const handlePointerDown = (event: PointerEvent) => setFromEvent(event, true);
    const handlePointerUp = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      point.pressed = false;
      // A lifted finger leaves nothing to reach for — touch is a momentary
      // attractor. A mouse keeps hovering until it leaves the window.
      if (event.pointerType !== "mouse") pointerState.target = null;
    };
    const handlePointerGone = () => {
      point.pressed = false;
      pointerState.target = null;
    };

    /** Size the drawing buffer to the current CSS box at the current scale. */
    const applySurface = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0) return;

      const bufferWidth = Math.max(1, Math.round(width * scale));
      const bufferHeight = Math.max(1, Math.round(height * scale));

      if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
      renderer?.resize(bufferWidth, bufferHeight);
    };

    /** The host box changed size: rebuild the surface and forget the cadence
     *  (the old samples measured a differently-sized surface). */
    const handleHostResize = () => {
      refreshSurfaceOffset();
      applySurface();
      quality?.reset();
    };

    const draw = (timestamp: number) => {
      if (disposed || !renderer || !field) return;

      // Adapt before drawing: sustained misses shed resolution, sustained
      // headroom sharpens it back, and the resize happens between frames.
      if (quality?.frame(timestamp)) {
        scale = quality.scale;
        applySurface();
        if (telemetry) telemetry.changes += 1;
      }

      if (telemetry) {
        telemetry.frames += 1;
        telemetry.scale = scale;
        telemetry.bufferWidth = canvas.width;
        telemetry.bufferHeight = canvas.height;
      }

      // Reduced motion keeps the sculpted mass (and its droplet colony) but
      // stops everything moving: the organism clock pins to zero and the
      // pointer attractor goes inert — present, never chasing.
      const frozen = motionQuery.matches;
      const seconds = timestamp / 1000;

      const stage = organism.frame(
        canvas.clientWidth,
        canvas.clientHeight,
        frozen ? 0 : seconds,
      );
      // The attractor folds in before the life sim so droplets orbit the
      // swollen, leaning geometry too.
      const reached = pointer.step(stage.nodes, pointerState.target, seconds, {
        frozen,
      });
      const living = life.step(reached, seconds, {
        // Reserve room for the tendril, which is prepended by reach() —
        // a full colony must not evict the pseudopod.
        maxDroplets: Math.max(
          0,
          renderer.capacity.drops - SLIME_POINTER_TENDRIL_DROPS,
        ),
        frozen,
      });
      const droplets = pointer.reach(living.droplets);
      packSlimeField(living.nodes, stage.edges, scale, field, droplets);

      if (telemetry) {
        telemetry.dropCount = field.dropCount;
        const snap = pointer.snapshot();
        telemetry.pointerWeight = snap.weight;
        telemetry.pointerTouched = snap.touched;
        telemetry.frozen = frozen;
        let checksum = 0;
        let maxRadius = 0;
        const blobEnd = field.blobCount * 4;
        for (let i = 0; i < blobEnd; i += 1) {
          checksum += field.blobs[i] * ((i & 7) + 1);
          if ((i & 3) === 3 && field.blobs[i] > maxRadius) {
            maxRadius = field.blobs[i];
          }
        }
        const linkEnd = field.linkCount * 4;
        for (let i = 0; i < linkEnd; i += 1) {
          checksum += (field.linkA[i] + field.linkB[i]) * ((i & 7) + 1);
        }
        const dropEnd = field.dropCount * 4;
        for (let i = 0; i < dropEnd; i += 1) {
          checksum += field.drops[i] * ((i & 7) + 1);
        }
        telemetry.fieldChecksum = checksum;
        telemetry.maxBlobRadius = scale > 0 ? maxRadius / scale : maxRadius;
      }

      const time = frozen ? 0 : seconds;
      // Fusion distance lives in drawing-buffer pixels, so it has to track the
      // render scale or the goo merges harder on low-resolution surfaces.
      renderer.render(field, time, { ...STYLE, blend: STYLE.blend * scale });

      if (!shown) {
        // First frame is on screen: let the layer fade in over the page.
        shown = true;
        setRevealed(true);
      }

      frame = window.requestAnimationFrame(draw);
    };

    const start = () => {
      if (disposed || frame || !renderer) return;
      // The clock kept running while we were stopped; the gap is not a frame.
      quality?.reset();
      frame = window.requestAnimationFrame(draw);
    };

    const stop = () => {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };

    /** Build (or rebuild) the GL resources. Returns false if unavailable. */
    const build = () => {
      try {
        renderer = createSlimeRenderer(gl, {
          capacityOverride: capacityOverrideFromLocation(),
        });
      } catch {
        // No slime rather than a broken landing: the canvas stays empty and
        // the page keeps its plain near-black background.
        renderer = null;
        field = null;
        return false;
      }
      // The field must match the tier this context compiled — a restored
      // context can land on a different tier than the one before it.
      field = createEmptyField(renderer.capacity);

      const initialScale =
        pinnedScale ??
        initialRenderScale(canvas.clientWidth || window.innerWidth);
      // A pinned scale renders exactly as asked; otherwise the measured frame
      // cadence owns the scale from here on.
      quality =
        pinnedScale !== null
          ? null
          : createAdaptiveQuality({
              initialScale,
              minScale: MIN_RENDER_SCALE,
              maxScale: maxRenderScale(),
            });
      scale = quality?.scale ?? initialScale;

      if (IS_UI_TEST) {
        telemetry = {
          pinned: pinnedScale !== null,
          scale,
          initialScale: scale,
          minScale: MIN_RENDER_SCALE,
          maxScale: maxRenderScale(),
          frames: 0,
          changes: 0,
          bufferWidth: 0,
          bufferHeight: 0,
          capacity: { ...renderer.capacity },
          dropCount: 0,
          pointerWeight: 0,
          pointerTouched: 0,
          frozen: false,
          fieldChecksum: 0,
          maxBlobRadius: 0,
        };
        window.__venomLandingSlime = telemetry;
      }

      refreshSurfaceOffset();
      applySurface();
      return true;
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    // A lost context invalidates every program and buffer we hold. Without
    // this the loop would keep drawing with dead handles and the layer would
    // stay broken until the page was reloaded.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      stop();
      renderer = null;
    };

    const handleContextRestored = () => {
      if (disposed) return;
      if (build()) start();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    if (build()) start();

    const observer = new ResizeObserver(handleHostResize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("pointercancel", handlePointerUp, {
      passive: true,
    });
    window.addEventListener("blur", handlePointerGone);
    document.documentElement.addEventListener("mouseleave", handlePointerGone);

    return () => {
      disposed = true;
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("blur", handlePointerGone);
      document.documentElement.removeEventListener(
        "mouseleave",
        handlePointerGone,
      );
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      renderer?.dispose();
      renderer = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="landing-slime"
      className={
        "pointer-events-none absolute inset-0 -z-10 h-full w-full " +
        "transition-opacity duration-1000 ease-out motion-reduce:transition-none " +
        (revealed ? "opacity-100" : "opacity-0")
      }
    />
  );
}
