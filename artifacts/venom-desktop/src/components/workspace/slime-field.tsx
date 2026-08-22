import { useEffect, useRef } from "react";
import {
  createAdaptiveQuality,
  createEmptyField,
  createSlimeBloom,
  createSlimeEmphasis,
  createSlimeLife,
  createSlimeMomentum,
  createSlimeRenderer,
  packSlimeField,
  slimeCapacityForTierName,
  type AdaptiveQuality,
  type SlimeEdge,
  type SlimeField,
  type SlimeNode,
  type SlimeRenderer,
  type SlimeStyle,
} from "@workspace/slime";
import { cn } from "@/lib/utils";
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
type SlimeTelemetry = {
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
};

declare global {
  interface Window {
    __venomSlime?: SlimeTelemetry;
  }
}

type SlimeFieldCanvasProps = {
  nodes: readonly SlimeNode[];
  edges: readonly SlimeEdge[];
  /** Concept the user has committed to; the mass swells hardest around it. */
  selectedId?: string | null;
  /** Concept under the pointer; a lighter version of the same reaction. */
  hoveredId?: string | null;
  className?: string;
};

const STYLE: SlimeStyle = {
  ink: [0.02, 0.02, 0.024],
  light: [1, 1, 1],
  alpha: 0.96,
  blend: 26,
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
 *
 * Raymarching costs per pixel, so a phone at DPR 3 would otherwise open by
 * shading nine times the work of a logical pixel. This is only the opening
 * guess: from here the measured frame cadence sheds resolution on slow
 * devices and sharpens on capable ones.
 */
function initialRenderScale(width: number) {
  const budget = width < 768 ? 0.62 : 0.78;
  return Math.max(0.4, maxRenderScale() * budget);
}

/**
 * The living symbiote layer behind the knowledge map.
 *
 * Rendering happens entirely from refs so that camera drags and hover state do
 * not tear down the GL context. If WebGL is unavailable or the program fails to
 * build, the canvas quietly stays empty and the map above it is unaffected.
 */
export function SlimeFieldCanvas({
  nodes,
  edges,
  selectedId = null,
  hoveredId = null,
  className,
}: SlimeFieldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef({ nodes, edges, selectedId, hoveredId });

  sceneRef.current = { nodes, edges, selectedId, hoveredId };

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
    // Droplet life state survives context loss on purpose: the colony picks
    // up where it left off when the program is rebuilt.
    const life = createSlimeLife();
    // Touch emphasis lives beside it for the same reason: a rebuilt context
    // resumes mid-reaction instead of re-easing from rest.
    const emphasis = createSlimeEmphasis();
    // Camera momentum too: the mass trails a flung map and settles, and a
    // restored context resumes mid-settle rather than snapping into place.
    const momentum = createSlimeMomentum();
    // Bloom-in for newly absorbed concepts is session-scoped for the same
    // reason again: a rebuilt context must not treat the whole map as new.
    const bloom = createSlimeBloom();

    const pinnedScale = scaleOverrideFromLocation();

    let renderer: SlimeRenderer | null = null;
    let field: SlimeField | null = null;
    let quality: AdaptiveQuality | null = null;
    let telemetry: SlimeTelemetry | null = null;
    let frame = 0;
    let scale = 1;
    let disposed = false;

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

      const scene = sceneRef.current;

      // Reduced motion keeps the sculpted 3D mass (and its droplet colony)
      // but stops everything moving: the sim is frozen, not emptied.
      const frozen = motionQuery.matches;
      // Camera momentum first, on the raw projected stream: a fling makes
      // the mass lag, stretch and settle instead of reprojecting rigidly.
      // Frozen means rigid motion — no added animation for reduced motion.
      const flung = momentum.step(scene.nodes, timestamp / 1000, { frozen });
      // Newly absorbed concepts grow out of the mass next, on the trailed
      // geometry, so everything downstream — touch swell, droplet orbits —
      // tracks the growing size; frozen shows newcomers full-size at once.
      const grown = bloom.step(flung, timestamp / 1000, { frozen });
      // The mass leans toward the concept the user is on. Folded in after
      // momentum (so the touch reaction stays as tuned, on the trailed
      // geometry) and before the life step so droplets orbit the swollen
      // radius too; frozen means the state change lands instantly instead
      // of easing.
      const touched = emphasis.step(
        grown,
        scene.edges,
        { selectedId: scene.selectedId, hoveredId: scene.hoveredId },
        timestamp / 1000,
        { frozen },
      );
      const living = life.step(touched, timestamp / 1000, {
        maxDroplets: renderer.capacity.drops,
        frozen,
      });
      packSlimeField(living.nodes, scene.edges, scale, field, living.droplets);
      if (telemetry) telemetry.dropCount = field.dropCount;

      const time = frozen ? 0 : timestamp / 1000;
      // Fusion distance lives in drawing-buffer pixels, so it has to track the
      // render scale or the goo merges harder on low-resolution surfaces.
      renderer.render(field, time, { ...STYLE, blend: STYLE.blend * scale });

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
        // No slime rather than a broken stage.
        renderer = null;
        field = null;
        return false;
      }
      // The field must match the tier this context compiled — a restored
      // context can land on a different tier than the one before it.
      field = createEmptyField(renderer.capacity);

      const initialScale =
        pinnedScale ?? initialRenderScale(canvas.clientWidth || window.innerWidth);
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
        };
        window.__venomSlime = telemetry;
      }

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

    return () => {
      disposed = true;
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
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
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full",
        className,
      )}
    />
  );
}
