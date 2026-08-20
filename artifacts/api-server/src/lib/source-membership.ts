/**
 * Returns whether a Clerk user is explicitly authorized to use the
 * deployment's shared GitHub connector. The connector is a workspace resource,
 * so this check must happen before every proxy request.
 */
export function isGitHubWorkspaceMember(
  userId: string,
  configuredMembers = process.env.VENOM_GITHUB_MEMBER_IDS ?? "",
): boolean {
  if (!/^user_[A-Za-z0-9]+$/.test(userId)) {
    return false;
  }

  return configuredMembers
    .split(",")
    .map((member) => member.trim())
    .filter((member) => /^user_[A-Za-z0-9]+$/.test(member))
    .includes(userId);
}