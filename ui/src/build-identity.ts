// Shared by Settings and the About window: one rendering of `GET /api/build`.
export function buildIdentityText(identity: Record<string, unknown>) {
  const text = (name: string) => typeof identity[name] === "string" && identity[name] ? identity[name] as string : "unavailable";
  // Without a revision the tree state is unknown, never clean.
  const dirty = text("revision") === "unavailable" ? undefined : identity.dirty;
  const workingTree = typeof dirty === "boolean" ? dirty ? "dirty" : "clean" : "unavailable";
  return [
    `App version: ${text("app_version")}`,
    `Server version: ${text("server_version")}`,
    `Revision: ${text("revision")}`,
    `Working tree: ${workingTree}`,
    `Embedded UI SHA-256: ${text("ui_hash")}`,
  ].join("\n");
}
