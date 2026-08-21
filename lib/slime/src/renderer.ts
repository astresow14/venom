import { SLIME_VERTEX_SHADER, buildSlimeFragmentShader } from "./shader";
import {
  SLIME_CAPACITY_TIERS,
  SOFTWARE_SLIME_CAPACITY,
  capacityForBudget,
  isSoftwareGlRenderer,
  slimeUniformVectorsFor,
  type SlimeCapacity,
  type SlimeField,
} from "./field";

/**
 * The subset of WebGL both `HTMLCanvasElement.getContext("webgl")` and the
 * expo-gl context satisfy. Typing against this instead of the DOM lib keeps the
 * package usable from React Native, which has no `WebGLRenderingContext`
 * global.
 */
export type SlimeGL = WebGLRenderingContext;

export type SlimeStyle = {
  /** Base body colour of the slime, linear RGB in the 0..1 range. */
  ink: readonly [number, number, number];
  /** Rim and highlight colour, linear RGB in the 0..1 range. */
  light: readonly [number, number, number];
  /** Overall opacity of the slime layer. */
  alpha: number;
  /**
   * How eagerly neighbouring surfaces fuse, in drawing-buffer pixels. Larger
   * values pull longer strands between connected nodes.
   */
  blend: number;
};

export type SlimeRenderer = {
  /** The tier this context could afford; size fields and populations to it. */
  capacity: SlimeCapacity;
  render(field: SlimeField, time: number, style: SlimeStyle): void;
  resize(width: number, height: number): void;
  dispose(): void;
};

const QUAD = new Float32Array([-1, -1, 3, -1, -1, 3]);

function compile(gl: SlimeGL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate slime shader");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown error";
    gl.deleteShader(shader);
    throw new Error(`Slime shader failed to compile: ${log}`);
  }

  return shader;
}

/**
 * WebGL rejects a uniform*v upload larger than the declared array, so when a
 * field was allocated at a richer tier than this context compiled, hand the
 * driver a prefix view. Views are cached per source array — fields are
 * long-lived, so this allocates once, not per frame.
 */
function createUploadView(length: number) {
  let source: Float32Array | null = null;
  let view: Float32Array | null = null;
  return (data: Float32Array): Float32Array => {
    if (data.length <= length) return data;
    if (source !== data || !view) {
      source = data;
      view = data.subarray(0, length);
    }
    return view;
  };
}

/**
 * Best-effort name of the device actually rasterizing this context.
 *
 * Prefers the unmasked string (modern Chromium exposes it, and it is the one
 * that names SwiftShader), falls back to the plain RENDERER, and returns ""
 * on contexts that refuse both — expo-gl on native, for instance, has no
 * getExtension guarantee, and detection must never break rendering.
 */
function readGlRendererLabel(gl: SlimeGL): string {
  try {
    const debugInfo = gl.getExtension?.("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const unmasked = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : null;
    const label = unmasked ?? gl.getParameter(gl.RENDERER);
    return typeof label === "string" ? label : "";
  } catch {
    return "";
  }
}

/**
 * Compile the slime program and return a small render loop driver.
 *
 * Throws when the context cannot compile or link the program, or when even
 * the smallest capacity tier exceeds its uniform budget. Callers are expected
 * to catch that and fall back to their non-WebGL presentation rather than
 * leaving the user with an empty stage.
 */
export type SlimeRendererOptions = {
  /**
   * Pin the capacity instead of trusting device detection. A test hook: lets
   * captures show the full organism on rasterizers that would normally be
   * tiered down. Ignored when the uniform budget cannot hold it.
   */
  capacityOverride?: SlimeCapacity | null;
};

export function createSlimeRenderer(
  gl: SlimeGL,
  options?: SlimeRendererOptions,
): SlimeRenderer {
  // The blob, link and droplet arrays dominate the fragment uniform budget.
  // WebGL 1 only guarantees 16 vectors, far below what this program needs, so
  // read the real limit up front and compile whichever tier fits — weaker
  // GPUs get a smaller population instead of a driver-specific link failure.
  const availableVectors = gl.getParameter(
    gl.MAX_FRAGMENT_UNIFORM_VECTORS,
  ) as number;

  const fits = (tier: SlimeCapacity) =>
    availableVectors >= slimeUniformVectorsFor(tier) ||
    !Number.isFinite(availableVectors);

  const override = options?.capacityOverride ?? null;

  // Uniform budget says nothing about raster speed: software rasterizers
  // report generous limits and then take the better part of a second per
  // frame on a dense field. Pin them to the sparse tier — a field the same
  // size the original shader drew, which they demonstrably kept responsive.
  const capacity = override
    ? fits(override)
      ? override
      : null
    : isSoftwareGlRenderer(readGlRendererLabel(gl))
      ? fits(SOFTWARE_SLIME_CAPACITY)
        ? SOFTWARE_SLIME_CAPACITY
        : null
      : capacityForBudget(availableVectors);

  if (!capacity) {
    const smallest = SLIME_CAPACITY_TIERS[SLIME_CAPACITY_TIERS.length - 1];
    throw new Error(
      `Slime needs ${slimeUniformVectorsFor(smallest)} fragment uniform vectors, this context offers ${availableVectors}`,
    );
  }

  const vertex = compile(gl, gl.VERTEX_SHADER, SLIME_VERTEX_SHADER);
  const fragment = compile(
    gl,
    gl.FRAGMENT_SHADER,
    buildSlimeFragmentShader(capacity),
  );
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("Unable to allocate slime program");
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown error";
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error(`Slime program failed to link: ${log}`);
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

  const aPosition = gl.getAttribLocation(program, "aPosition");
  const uniform = (name: string) => gl.getUniformLocation(program, name);

  const locations = {
    resolution: uniform("uResolution"),
    time: uniform("uTime"),
    blend: uniform("uBlend"),
    alpha: uniform("uAlpha"),
    ink: uniform("uInk"),
    light: uniform("uLight"),
    blobCount: uniform("uBlobCount"),
    blobs: uniform("uBlobs"),
    linkCount: uniform("uLinkCount"),
    linkA: uniform("uLinkA"),
    linkB: uniform("uLinkB"),
    dropCount: uniform("uDropCount"),
    drops: uniform("uDrops"),
  };

  const blobsView = createUploadView(capacity.blobs * 4);
  const linkAView = createUploadView(capacity.links * 4);
  const linkBView = createUploadView(capacity.links * 4);
  const dropsView = createUploadView(capacity.drops * 4);

  let width = 1;
  let height = 1;
  let disposed = false;

  return {
    capacity,

    resize(nextWidth: number, nextHeight: number) {
      width = Math.max(1, Math.floor(nextWidth));
      height = Math.max(1, Math.floor(nextHeight));
    },

    render(field: SlimeField, time: number, style: SlimeStyle) {
      if (disposed) return;

      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (field.blobCount <= 0) return;

      gl.useProgram(program);
      gl.enable(gl.BLEND);
      // Premultiplied-alpha blending: the shader already scales colour by the
      // coverage it reports, so compositing over the page stays clean.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(locations.resolution, width, height);
      gl.uniform1f(locations.time, time);
      gl.uniform1f(locations.blend, style.blend);
      gl.uniform1f(locations.alpha, style.alpha);
      gl.uniform3f(locations.ink, style.ink[0], style.ink[1], style.ink[2]);
      gl.uniform3f(
        locations.light,
        style.light[0],
        style.light[1],
        style.light[2],
      );

      gl.uniform1i(
        locations.blobCount,
        Math.min(field.blobCount, capacity.blobs),
      );
      gl.uniform4fv(locations.blobs, blobsView(field.blobs));
      gl.uniform1i(
        locations.linkCount,
        Math.min(field.linkCount, capacity.links),
      );
      gl.uniform4fv(locations.linkA, linkAView(field.linkA));
      gl.uniform4fv(locations.linkB, linkBView(field.linkB));
      // A dropless tier compiles without the droplet uniforms at all, so skip
      // the upload rather than poking null locations every frame.
      if (capacity.drops > 0) {
        gl.uniform1i(
          locations.dropCount,
          Math.min(field.dropCount, capacity.drops),
        );
        gl.uniform4fv(locations.drops, dropsView(field.drops));
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}
