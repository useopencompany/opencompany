const SIGN_OFF_PATTERN = /^Signed-off-by:\s+.+\s+<[^<>\s@]+@[^<>\s]+>\s*$/imu;

export function hasValidDcoSignoff(message) {
  const paragraphs = (message ?? "").trimEnd().split(/\r?\n\s*\r?\n/u);
  return SIGN_OFF_PATTERN.test(paragraphs.at(-1) ?? "");
}

export function unsignedCommits(commits) {
  return commits.filter((commit) => !hasValidDcoSignoff(commit.message));
}
