/** Small git helpers shared by the GitHub sync and its drift check. */

import { spawnSync } from "node:child_process";

export class SyncError extends Error {}

export function git(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new SyncError(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new SyncError(`git ${args.join(" ")} failed:\n${detail}`);
  }

  return (result.stdout ?? "").trim();
}

/**
 * Run git with optional stdin and capture stdout verbatim.
 *
 * Plumbing such as `cat-file --batch` emits object contents, which may be
 * binary and must not be decoded or trimmed on the way out. An explicit `env`
 * lets index plumbing point `GIT_INDEX_FILE` at a scratch index.
 */
export function gitRaw(args: string[], input?: string, env?: NodeJS.ProcessEnv): Buffer {
  const result = spawnSync("git", args, {
    input,
    env: env ?? process.env,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new SyncError(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
    throw new SyncError(`git ${args.join(" ")} failed:\n${detail}`);
  }

  return result.stdout ?? Buffer.alloc(0);
}

/** Run git for its exit code only; never throws on a non-zero status. */
export function gitStatus(args: string[], env?: NodeJS.ProcessEnv): number {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status ?? 1;
}

/**
 * Pass the credential to git in memory only: `GIT_CONFIG_COUNT` +
 * `http.extraheader` keeps it out of `.git/config` and out of remote URLs.
 */
export function gitEnvWithToken(token: string): NodeJS.ProcessEnv {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}
