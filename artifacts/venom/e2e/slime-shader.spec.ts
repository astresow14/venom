import { test, expect } from "@playwright/test";

import {
  buildSlimeFragmentShader,
  SLIME_VERTEX_SHADER,
  FULL_SLIME_CAPACITY,
  SOFTWARE_SLIME_CAPACITY,
  slimeCapacityForTierName,
} from "../../../lib/slime/src";

/**
 * Compiles every capacity tier's generated shader in a real browser WebGL
 * context. Headless Chromium rasterizes with SwiftShader — the same software
 * renderer the dedicated sparse tier exists for — so this is a live proof
 * that each tier (droplet-free software tier included) actually compiles and
 * links instead of silently falling back to the plain map.
 */
const TIERS = {
  full: FULL_SLIME_CAPACITY,
  medium: slimeCapacityForTierName("medium")!,
  compact: slimeCapacityForTierName("compact")!,
  software: SOFTWARE_SLIME_CAPACITY,
} as const;

test("every slime capacity tier compiles and links under this browser's renderer", async ({
  page,
}) => {
  const sources = Object.fromEntries(
    Object.entries(TIERS).map(([name, capacity]) => [
      name,
      buildSlimeFragmentShader(capacity),
    ]),
  ) as Record<keyof typeof TIERS, string>;

  const results = await page.evaluate(
    ({ vertexSource, fragments }) => {
      const outcomes: Record<string, string> = {};
      for (const [name, fragmentSource] of Object.entries(fragments)) {
        const canvas = document.createElement("canvas");
        const gl =
          canvas.getContext("webgl") ??
          (canvas.getContext(
            "experimental-webgl",
          ) as WebGLRenderingContext | null);
        if (!gl) {
          outcomes[name] = "no webgl context";
          continue;
        }
        const compile = (type: number, source: string) => {
          const shader = gl.createShader(type);
          if (!shader) return { shader: null, log: "createShader failed" };
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
          return { shader, log: ok ? "" : gl.getShaderInfoLog(shader) ?? "?" };
        };
        const vertex = compile(gl.VERTEX_SHADER, vertexSource);
        const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
        if (!vertex.shader || vertex.log) {
          outcomes[name] = `vertex: ${vertex.log}`;
          continue;
        }
        if (!fragment.shader || fragment.log) {
          outcomes[name] = `fragment: ${fragment.log}`;
          continue;
        }
        const program = gl.createProgram();
        if (!program) {
          outcomes[name] = "createProgram failed";
          continue;
        }
        gl.attachShader(program, vertex.shader);
        gl.attachShader(program, fragment.shader);
        gl.linkProgram(program);
        const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
        outcomes[name] = linked
          ? "ok"
          : `link: ${gl.getProgramInfoLog(program) ?? "?"}`;
      }
      return outcomes;
    },
    { vertexSource: SLIME_VERTEX_SHADER, fragments: sources },
  );

  for (const name of Object.keys(TIERS)) {
    expect(results[name], `${name} tier shader`).toBe("ok");
  }
});
