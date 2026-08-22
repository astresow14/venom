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
 *
 * Every tier gets its own context, and all compiles and links are submitted
 * before any status is queried: a status query blocks on that context's
 * outstanding work, so asking early would serialize the tiers. Where the
 * driver offers KHR_parallel_shader_compile the tiers genuinely compile
 * concurrently on its worker threads and completion is polled without
 * blocking; without the extension the code degrades to the old serial cost.
 * The assertions are unchanged either way: each tier's vertex shader,
 * fragment shader, and program link must all succeed.
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
    async ({ vertexSource, fragments }) => {
      type Job = {
        name: string;
        outcome?: string;
        gl?: WebGLRenderingContext;
        vertex?: WebGLShader;
        fragment?: WebGLShader;
        program?: WebGLProgram;
        parallel?: KHR_parallel_shader_compile | null;
      };

      // Submit every tier's compile + link first; query nothing yet.
      const jobs: Job[] = [];
      for (const [name, fragmentSource] of Object.entries(fragments)) {
        const job: Job = { name };
        jobs.push(job);
        const canvas = document.createElement("canvas");
        const gl =
          canvas.getContext("webgl") ??
          (canvas.getContext(
            "experimental-webgl",
          ) as WebGLRenderingContext | null);
        if (!gl) {
          job.outcome = "no webgl context";
          continue;
        }
        job.gl = gl;
        // Requesting the extension is what switches the driver to its
        // worker-thread compile path; null simply means "serial as before".
        job.parallel = gl.getExtension("KHR_parallel_shader_compile");
        const make = (type: number, source: string) => {
          const shader = gl.createShader(type);
          if (!shader) return null;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          return shader;
        };
        const vertex = make(gl.VERTEX_SHADER, vertexSource);
        if (!vertex) {
          job.outcome = "vertex: createShader failed";
          continue;
        }
        const fragment = make(gl.FRAGMENT_SHADER, fragmentSource);
        if (!fragment) {
          job.outcome = "fragment: createShader failed";
          continue;
        }
        const program = gl.createProgram();
        if (!program) {
          job.outcome = "createProgram failed";
          continue;
        }
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        job.vertex = vertex;
        job.fragment = fragment;
        job.program = program;
      }

      // Let parallel-capable contexts finish off-thread before touching any
      // blocking query. A compile that never completes is the test timing
      // out — the driver guarantees COMPLETION_STATUS_KHR eventually flips.
      const stillCompiling = () =>
        jobs.some(
          (job) =>
            !job.outcome &&
            job.parallel &&
            job.gl!.getProgramParameter(
              job.program!,
              job.parallel.COMPLETION_STATUS_KHR,
            ) !== true,
        );
      while (stillCompiling()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Same per-tier diagnostics as ever, now that nothing here can block
      // on a compile still in flight: a failed stage names itself.
      const outcomes: Record<string, string> = {};
      for (const job of jobs) {
        if (job.outcome) {
          outcomes[job.name] = job.outcome;
          continue;
        }
        const gl = job.gl!;
        if (!gl.getShaderParameter(job.vertex!, gl.COMPILE_STATUS)) {
          outcomes[job.name] =
            `vertex: ${gl.getShaderInfoLog(job.vertex!) ?? "?"}`;
          continue;
        }
        if (!gl.getShaderParameter(job.fragment!, gl.COMPILE_STATUS)) {
          outcomes[job.name] =
            `fragment: ${gl.getShaderInfoLog(job.fragment!) ?? "?"}`;
          continue;
        }
        outcomes[job.name] = gl.getProgramParameter(
          job.program!,
          gl.LINK_STATUS,
        )
          ? "ok"
          : `link: ${gl.getProgramInfoLog(job.program!) ?? "?"}`;
      }
      return outcomes;
    },
    { vertexSource: SLIME_VERTEX_SHADER, fragments: sources },
  );

  for (const name of Object.keys(TIERS)) {
    expect(results[name], `${name} tier shader`).toBe("ok");
  }
});
