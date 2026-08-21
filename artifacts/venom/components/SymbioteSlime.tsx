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
  createSlimeEmphasis,
  createSlimeLife,
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
};

type SymbioteSlimeProps = {
  /** Nodes already projected into map space, matching the node layer above. */
  nodes: readonly SlimeNode[];
  edges: readonly SlimeEdge[];
  /** Width and height of the square map these coordinates belong to. */
  mapSize: number;
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
  reduceMotion = false,
  selectedId = null,
  touchedId = null,
  capacityOverride = null,
  surfaceFractionOverride = null,
  exposeTelemetry = false,
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
  };

  useEffect(() => () => teardownRef.current?.(), []);

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

    const telemetry: SlimeTelemetry | null = sceneRef.current.exposeTelemetry
      ? {
          pinned,
          scale: fractionRef.current,
          initialScale: fractionRef.current,
          minScale: bounds.min,
          maxScale: bounds.max,
          frames: 0,
          changes: 0,
          bufferWidth: 0,
          bufferHeight: 0,
        }
      : null;
    if (telemetry) {
      (globalThis as { __venomSlime?: SlimeTelemetry }).__venomSlime =
        telemetry;
    }

    let frame = 0;
    let stopped = false;
    let bufferWidth = 0;
    let bufferHeight = 0;
    const startedAt = Date.now();

    const draw = () => {
      if (stopped) return;

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
          if (telemetry) telemetry.changes += 1;
          // Resizing the laid-out view resizes the drawing buffer; the
          // per-frame measurement above picks the new size up when it lands.
          setFraction(quality.scale);
        }

        if (telemetry) {
          telemetry.frames += 1;
          telemetry.scale = fractionRef.current;
          telemetry.bufferWidth = width;
          telemetry.bufferHeight = height;
        }

        const scene = sceneRef.current;
        // Map-space pixels to drawing-buffer pixels. The layout downscale is
        // cancelled out by the transform, so this is the only conversion.
        const scale = width / Math.max(scene.mapSize, 1);

        // Droplet life runs in map space against the already-projected nodes,
        // so pan and zoom carry the whole colony. Reduced motion freezes the
        // sim: same population, no movement.
        const now = (Date.now() - startedAt) / 1000;
        // The mass leans toward the concept the user is touching. Folded in
        // before the life step so droplets orbit the swollen radius too;
        // reduced motion applies the state change instantly instead of
        // easing it.
        const touched = emphasis.step(
          scene.nodes,
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

        const time = scene.reduceMotion ? 0 : now;
        // Fusion distance is in drawing-buffer pixels, so it has to track the
        // same conversion the positions use.
        renderer.render(field, time, { ...STYLE, blend: STYLE.blend * scale });

        // Native contexts need an explicit flush; the web shim has no such call.
        gl.endFrameEXP?.();
      } else {
        // While the surface is missing (backgrounded, mid-layout) the clock
        // keeps running; those gaps are pauses, not frames.
        quality?.reset();
      }

      frame = requestAnimationFrame(draw);
    };

    draw();

    teardownRef.current = () => {
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
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
      />
    </View>
  );
}
