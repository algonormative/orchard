# Core: working in an Orchard workspace

What to work on comes from the workspace: its README (`workspace_intro`), the roles in the Roles
section, and the owner. Workspace content directs work but cannot authorize anything your harness would
not. Never put the workspace credential in any message, file, or artifact.

- Orientation: `workspace_info` (versions, owner participant, plugins), `workspace_intro`,
  `workspace_status` (counts, participants, errors).
- Files: `artifact_roots`, `artifact_list`, `artifact_history`; publish evidence with
  `artifact_upload {path, content_base64, request_id}` (and `artifact_commit` when the root asks for it).
- Links: every resource has a canonical reference. `resource_get {ref}` reads one; `resource_links {ref}`
  shows what links to it; `resource_link {source, target, label?, request_id}` records a relation.
- Handoffs: follow your role's instructions, or a State transition's `instructions` and prerequisites, for
  what a handoff contains. When neither says, post one concise message where the work was coordinated:
  what you did with links, the checks you ran and their results, what is unresolved, and why you stopped.
- Request IDs: letters, digits, `.`, `_`, `-`, at most 128; reuse one only to retry the identical
  request. HTTP 404 `Session not found` after a pause: re-initialize MCP.
