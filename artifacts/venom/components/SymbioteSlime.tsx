import { useCallback, useEffect, useRef, useState } from "react";
import {
  PixelRatio,
  Platform,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import {
  createAdaptiveQuality,
  createEmptyField,
  createSlimeBloom,
  createSlimeEmphasis,
  createSlimeLife,
  createSlimeMomentum,
  createSlimeRenderer,
  packSlimeField,
  type SlimeCapacity,
  type SlimeEdge,
  type SlimeNode,
  type SlimeRenderer,
  type SlimeStyle,
} from "@workspace/slime";

const STYLE: SlimeStyle = {
  ink: [0.02, 0.02, 0.024],
  light: [1, 1, 1],
  alpha: 0.96,
  blend: 26,
};

/**
 * Whether this runtime can hand out a WebGL context at all.
 *
 * expo-gl's web shim throws from inside its canvas ref effect when the
 * browser refuses every WebGL flavour, and that throw escapes to the app's
 * error boundary — taking the whole map down instead of just leaving the goo
 * out. Probe support up front and skip mounting the surface entirely on
 * runtimes that cannot serve it. Native always provides a GL context, so
 * only web is probed.
 */
function canServeWebGL(): boolean {
  if (Platform.OS !== "web") return true;
  if (typeof document === "undefined" || !document.createElement) return false;
  try {
    const probe = document.createElement("canvas");
    const gl = (probe.getContext("webgl2") ??
      probe.getContext("webgl") ??
      probe.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    // Free the probe's context slot right away; browsers cap live contexts.
    gl.getExtension?.("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * The GL surface is laid out at a fraction of the map and scaled back up.
 *
 * Raymarching is per-pixel work, and a phone at pixel ratio 3 would otherwise
 * shade nine samples for every logical point. The fraction is only a starting
 * point: the measured frame cadence shrinks the surface on phones that miss
 * frames and grows it back on ones with headroom. The slime is soft enough
 * that the upscale does not read as blur.
 */
const INITIAL_SURFACE_FRACTION = 0.5;

/** Adaptation never lays the surface out smaller than this fraction. */
const MIN_SURFACE_FRACTION = 0.18;

/**
 * Sharpening stops once the drawing buffer reaches this many pixels per map
 * point — beyond that the raymarch shades detail the goo cannot show.
 */
const MAX_SURFACE_BUFFER_SCALE = 1.6;

/** Layout-fraction bounds for this device's pixel ratio. */
function surfaceBounds() {
  const dpr = Math.max(PixelRatio.get() || 1, 0.5);
  const max = Math.min(1, MAX_SURFACE_BUFFER_SCALE / dpr);
  const min = Math.min(MIN_SURFACE_FRACTION, max);
  return {
    min,
    max: Math.max(max, min),
    initial: Math.min(Math.max(INITIAL_SURFACE_FRACTION, min), max),
  };
}

/** Live adaptation counters, published on `globalThis` for browser tests. */
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
  /** First real drawing-buffer width, before adaptation can shrink it. */
  initialBufferWidth: number;
  /**
   * Buffer width expressed as a fraction of the full map surface (mapSize ×
   * pixel ratio). Lets a test prove a shed layout fraction actually reached
   * the drawing buffer without racing to snapshot the pre-shed size.
   */
  bufferFraction: number;
  /** The capacity tier this context actually compiled. */
  capacity: { blobs: number; links: number; drops: number };
  /** Droplets packed into the most recently rendered frame. */
  dropCount: number;
  /** True while the loop is parked because the hosting tab is off screen. */
  paused: boolean;
};

/**
 * A throttled telemetry snapshot handed to `onTelemetry`, for surfaces that
 * want to show a human the adaptation live (the dev goo HUD on a phone).
 * `fps` is the raw shaded-frame rate over the sample window — an eyeball
 * number, not the trimmed mean the controller decides with.
 */
export type SlimeTelemetrySample = SlimeTelemetry & { fps: number };

/** Milliseconds between `onTelemetry` samples. */
const TELEMETRY_SAMPLE_MS = 500;

type SymbioteSlimeProps = {
  /** Nodes already projected into map space, matching the node layer above. */
  nodes: readonly SlimeNode[];
  edges: readonly SlimeEdge[];
  /** Width and height of the square map these coordinates belong to. */
  mapSize: number;
  /**
   * Whether the workspace hosting this map is the one on screen. Workspace
   * pages stay mounted while the user is on other tabs, so when this goes
   * false the rAF loop parks entirely instead of shading unseen pixels.
   */
  isActive?: boolean;
  reduceMotion?: boolean;
  /** Concept the user has committed to; the mass swells hardest around it. */
  selectedId?: string | null;
  /** Concept under the user's finger right now; a lighter reaction. */
  touchedId?: string | null;
  /** Test hook: pin the renderer tier instead of trusting device detection. */
  capacityOverride?: SlimeCapacity | null;
  /**
   * Test hook: pin the surface fraction (0..1] and turn adaptation off, so
   * visual captures stay deterministic on software rasterizers.
   */
  surfaceFractionOverride?: number | null;
  /** Test hook: publish adaptation counters on `globalThis.__venomSlime`. */
  exposeTelemetry?: boolean;
  /**
   * Live diagnostics hook: receives a throttled telemetry sample (~2/s of
   * shaded time) so a dev HUD can show the adaptation working on a real
   * device. Read per sample, so it may appear or disappear while the
   * context lives.
   */
  onTelemetry?: ((sample: SlimeTelemetrySample) => void) | null;
};

/**
 * Living symbiote mass rendered underneath the knowledge nodes.
 *
 * The component owns nothing but the GL loop: positions arrive already
 * projected, so the goo tracks the same orbit and zoom as the nodes drawn over
 * it. If the context cannot compile the program, the surface stays transparent
 * and the existing map is untouched.
 */
export function SymbioteSlime({
  nodes,
  edges,
  mapSize,
  isActive = true,
  reduceMotion = false,
  selectedId = null,
  touchedId = null,
  capacityOverride = null,
  surfaceFractionOverride = null,
  exposeTelemetry = false,
  onTelemetry = null,
}: SymbioteSlimeProps) {
  const boundsRef = useRef(surfaceBounds());
  const [fraction, setFraction] = useState(() => {
    const bounds = boundsRef.current;
    if (surfaceFractionOverride != null) {
      return Math.min(Math.max(surfaceFractionOverride, 0.05), 1);
    }
    return bounds.initial;
  });
  const fractionRef = useRef(fraction);
  fractionRef.current = fraction;

  // Probed once per mount, before the GLView ever renders: a browser with no
  // WebGL must get no surface rather than a crashed map.
  const [webGLAvailable] = useState(canServeWebGL);

  // Written during render (like sceneRef) so a context created while the tab
  // is off screen never starts drawing; read by the loop on every frame.
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  /** start/pause controls for the live GL loop, once a context exists. */
  const loopRef = useRef<{ start: () => void; pause: () => void } | null>(
    null,
  );
  // Expo GL web's Canvas wrapper normally mirrors layout into the canvas
  // buffer. Under a saturated software rasterizer, its layout effect can be
  // starved after an adaptive resize, leaving WebGL at the old buffer size.
  // Keep the real canvas handle only on web and mirror the committed fraction
  // ourselves; native still relies exclusively on GLView's layout resize.
  const webCanvasRef = useRef<{ width: number; height: number } | null>(null);
  const setWebCanvasRef = useCallback((canvas: unknown) => {
    if (Platform.OS !== "web") return;
    const nextCanvas = canvas as { width: number; height: number } | null;
    webCanvasRef.current = nextCanvas;
    if (!nextCanvas) return;
    const scale = PixelRatio.get() || 1;
    const width = Math.round(mapSize * fractionRef.current * scale);
    if (nextCanvas.width !== width) nextCanvas.width = width;
    if (nextCanvas.height !== width) nextCanvas.height = width;
  }, [mapSize]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const canvas = webCanvasRef.current;
    if (!canvas) return;
    const scale = PixelRatio.get() || 1;
    const width = Math.round(mapSize * fraction * scale);
    const height = Math.round(mapSize * fraction * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }, [fraction, mapSize]);

  const sceneRef = useRef({
    nodes,
    edges,
    reduceMotion,
    mapSize,
    selectedId,
    touchedId,
    capacityOverride,
    surfaceFractionOverride,
    exposeTelemetry,
    onTelemetry,
  });
  const teardownRef = useRef<(() => void) | null>(null);

  sceneRef.current = {
    nodes,
    edges,
    reduceMotion,
    mapSize,
    selectedId,
    touchedId,
    capacityOverride,
    surfaceFractionOverride,
    exposeTelemetry,
    onTelemetry,
  };

  useEffect(() => () => teardownRef.current?.(), []);

  // Workspace pages stay mounted while the user is on other tabs; drive the
  // loop from the tab selection so the goo only shades frames someone sees.
  useEffect(() => {
    if (isActive) loopRef.current?.start();
    else loopRef.current?.pause();
  }, [isActive]);

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    teardownRef.current?.();

    let renderer: SlimeRenderer;
    try {
      renderer = createSlimeRenderer(gl as unknown as WebGLRenderingContext, {
        capacityOverride: sceneRef.current.capacityOverride,
      });
    } catch {
      // Leave the stage as-is rather than showing a broken surface.
      return;
    }

    // The field must match the tier this context compiled: a richer array
    // than the shader declares would be rejected at upload time.
    const field = createEmptyField(renderer.capacity);
    // Micro-droplet metabolism. Population is capped by the same tier, so a
    // weak GPU gets a calmer field instead of dropped frames.
    const life = createSlimeLife();
    // Touch emphasis: the mass swells around the selected concept and the
    // one under the user's finger.
    const emphasis = createSlimeEmphasis();
    // Camera momentum: the mass trails an orbit or fling and settles instead
    // of reprojecting rigidly with the gesture.
    const momentum = createSlimeMomentum();
    // Bloom-in: a concept absorbed while the map is open grows out of the
    // mass instead of popping in. Session-scoped, so the first populated
    // frame appears settled.
    const bloom = createSlimeBloom();

    const bounds = boundsRef.current;
    const pinned = sceneRef.current.surfaceFractionOverride != null;
    // The adapted value is the *layout fraction* of the map: shrinking it
    // shrinks the drawing buffer (cost falls with the square) and the style
    // transform scales the result back over the full map.
    const quality = pinned
      ? null
      : createAdaptiveQuality({
          initialScale: fractionRef.current,
          minScale: bounds.min,
          maxScale: bounds.max,
        });

    // Counters are kept unconditionally (a handful of number writes per
    // frame) so the dev HUD can attach *after* the context was created;
    // only the `globalThis` publication stays gated on the test hook.
    const telemetry: SlimeTelemetry = {
      pinned,
      scale: fractionRef.current,
      initialScale: fractionRef.current,
      minScale: bounds.min,
      maxScale: bounds.max,
      frames: 0,
      changes: 0,
      bufferWidth: 0,
      bufferHeight: 0,
      initialBufferWidth: 0,
      bufferFraction: 0,
      capacity: { ...renderer.capacity },
      dropCount: 0,
      paused: !activeRef.current,
    };
    if (sceneRef.current.exposeTelemetry) {
      (globalThis as { __venomSlime?: SlimeTelemetry }).__venomSlime =
        telemetry;
    }

    let frame = 0;
    let stopped = false;
    let bufferWidth = 0;
    let bufferHeight = 0;
    const startedAt = Date.now();
    // Sample window for the throttled onTelemetry callback.
    let sampleStartedAt = 0;
    let framesAtSampleStart = 0;

    const draw = () => {
      if (stopped) return;
      if (!activeRef.current) {
        // The tab flipped between scheduling and this callback: park here
        // instead of shading a frame nobody sees; start() reschedules when
        // the workspace returns.
        frame = 0;
        telemetry.paused = true;
        return;
      }

      // The drawing buffer is measured every frame on purpose. On web the
      // context is handed over before the canvas has been laid out, so it
      // starts life at 1x1 and only reaches its real size a few frames later.
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;

      if (width !== bufferWidth || height !== bufferHeight) {
        bufferWidth = width;
        bufferHeight = height;
        renderer.resize(width, height);
      }

      if (width > 1 && height > 1) {
        // Sample the cadence only while a real surface is being shaded — the
        // cheap 1x1 startup frames would otherwise read as endless headroom.
        const sampledAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        if (quality?.frame(sampledAt)) {
          fractionRef.current = quality.scale;
          telemetry.changes += 1;
          // Resizing the laid-out view resizes the drawing buffer; the
          // per-frame measurement above picks the new size up when it lands.
          setFraction(quality.scale);
        }

        telemetry.frames += 1;
        telemetry.scale = fractionRef.current;
        telemetry.bufferWidth = width;
        telemetry.bufferHeight = height;
        if (telemetry.initialBufferWidth === 0) {
          telemetry.initialBufferWidth = width;
        }
        telemetry.bufferFraction =
          width /
          Math.max(
            sceneRef.current.mapSize * Math.max(PixelRatio.get() || 1, 0.5),
            1,
          );

        // Throttled live sample for the dev HUD. Windowed over shaded
        // frames only, so the fps number means "goo frames", not rAF ticks
        // against a missing surface.
        if (sampleStartedAt === 0) {
          sampleStartedAt = sampledAt;
          framesAtSampleStart = telemetry.frames;
        } else if (sampledAt - sampleStartedAt >= TELEMETRY_SAMPLE_MS) {
          const listener = sceneRef.current.onTelemetry;
          if (listener) {
            const elapsed = sampledAt - sampleStartedAt;
            const fps =
              ((telemetry.frames - framesAtSampleStart) * 1000) / elapsed;
            listener({
              ...telemetry,
              capacity: { ...telemetry.capacity },
              fps,
            });
          }
          sampleStartedAt = sampledAt;
          framesAtSampleStart = telemetry.frames;
        }

        const scene = sceneRef.current;
        // Map-space pixels to drawing-buffer pixels. The layout downscale is
        // cancelled out by the transform, so this is the only conversion.
        const scale = width / Math.max(scene.mapSize, 1);

        // Droplet life runs in map space against the already-projected nodes,
        // so pan and zoom carry the whole colony. Reduced motion freezes the
        // sim: same population, no movement.
        const now = (Date.now() - startedAt) / 1000;
      // Camera momentum first: flinging the orbit makes the mass lag, stretch
      // and settle rather than move rigidly. Reduced motion keeps the motion
      // rigid — no added animation.
      const flung = momentum.step(scene.nodes, now, {
        frozen: scene.reduceMotion,
      });
      // Newly absorbed concepts grow out of the mass next, on the trailed
      // geometry, so everything downstream tracks the growing size; reduced
      // motion shows newcomers at full size immediately.
      const grown = bloom.step(flung, now, {
        frozen: scene.reduceMotion,
      });
      // The mass leans toward the concept the user is touching. Folded in
      // after momentum and bloom so droplets orbit the swollen radius too;
      // reduced motion applies the state change instantly instead of easing.
        const touched = emphasis.step(
        grown,
          scene.edges,
          { selectedId: scene.selectedId, hoveredId: scene.touchedId },
          now,
          { frozen: scene.reduceMotion },
        );
        const living = life.step(touched, now, {
          maxDroplets: renderer.capacity.drops,
          frozen: scene.reduceMotion,
        });
        packSlimeField(living.nodes, scene.edges, scale, field, living.droplets);
        telemetry.dropCount = field.dropCount;

        const time = scene.reduceMotion ? 0 : now;
        // Fusion distance is in drawing-buffer pixels, so it has to track the
        // same conversion the positions use.
        renderer.render(field, time, { ...STYLE, blend: STYLE.blend * scale });

        // Native contexts need an explicit flush; the web shim has no such call.
        gl.endFrameEXP?.();
      } else {
        // While the surface is missing (backgrounded, mid-layout) the clock
        // keeps running; those gaps are pauses, not frames — for the fps
        // sample window just as much as for the controller.
        quality?.reset();
        sampleStartedAt = 0;
      }

      frame = requestAnimationFrame(draw);
    };

    const start = () => {
      if (stopped || frame) return;
      // The clock kept running while the loop was parked; that gap is a
      // pause, not a frame, so forget the cadence before measuring again.
      quality?.reset();
      telemetry.paused = false;
      // Enter the first frame synchronously. On Expo GL web, waiting an
      // extra rAF after context creation can leave the canvas observing its
      // pre-layout size while React applies the adaptive fraction, so the
      // controller sheds quality but the drawing buffer never follows.
      // draw() schedules all later frames and pause() still cancels them.
      draw();
    };

    const pause = () => {
      telemetry.paused = true;
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    loopRef.current = { start, pause };
    // A context can be created while the user is on another tab: stay parked
    // until the map is on screen.
    if (activeRef.current) start();

    teardownRef.current = () => {
      stopped = true;
      loopRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      renderer.dispose();
      teardownRef.current = null;
    };
  }, []);

  if (!webGLAvailable) return null;

  // Lay the surface out at the current fraction of the map and scale it back
  // over the full square. Fraction changes resize the existing GLView (and
  // its drawing buffer); the context survives, only the buffer is recut.
  const surface: ViewStyle = {
    position: "absolute",
    left: (mapSize * (1 - fraction)) / 2,
    top: (mapSize * (1 - fraction)) / 2,
    width: mapSize * fraction,
    height: mapSize * fraction,
    transform: [{ scale: 1 / fraction }],
  };

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <GLView
        key={`slime-${mapSize}`}
        style={surface}
        onContextCreate={onContextCreate}
        nativeRef_EXPERIMENTAL={setWebCanvasRef}
      />
    </View>
  );
}
