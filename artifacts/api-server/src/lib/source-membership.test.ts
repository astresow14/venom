import assert from "node:assert/strict";
import test from "node:test";
import { isGitHubWorkspaceMember } from "./source-membership";

test("GitHub workspace connector rejects a signed-in non-member", () => {
  const configuredMembers = "user_workspaceowner, user_projectadmin";

  assert.equal(
    isGitHubWorkspaceMember("user_workspaceowner", configuredMembers),
    true,
  );
  assert.equal(
    isGitHubWorkspaceMember("user_otheraccount", configuredMembers),
    false,
  );
});

test("an unconfigured GitHub member allowlist fails closed", () => {
  assert.equal(isGitHubWorkspaceMember("user_anyone", ""), false);
});

test("a username in the GitHub member allowlist fails closed", () => {
  assert.equal(isGitHubWorkspaceMember("user_workspaceowner", "astresow14"), false);
  assert.equal(isGitHubWorkspaceMember("astresow14", "astresow14"), false);
});