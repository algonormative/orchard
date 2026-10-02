import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.ORCHARD_FIXTURE_PORT || 4174);
const dist = new URL("../dist/", import.meta.url);
const workspace = { id: "workspace-1", name: "Fixture workspace" };
const archivedWorkspace = { id: "archived-first", name: "Archived fixture", archived: true };
const taskStore = { id: "default", name: "Workspace tasks", source: "owned", path: "/private/tmp/orchard-fixture-workspaces/a-very-long-workspace-identifier-that-must-wrap-within-the-details-panel/tasks" };
const initialBuildIdentity = { app_version: "0.2.0", server_version: "0.1.0", ui_hash: "f".repeat(64) };
let buildIdentity = structuredClone(initialBuildIdentity);
const projectStore = { id: "repository:example-project", name: "example-project", source: "repository", repository_id: "project-example", path: "/private/tmp/example-project/.beads" };
let repositories = [];
const participants = [
  { id: "owner", name: "Owner" },
  { id: "alice", name: "Alice", last_contact_at: "2026-09-15T12:00:00Z" },
];
const channels = [{ id: "general", name: "general" }, { id: "orchard-system", name: "orchard-system" }];
let created = false;
let workspaces = [];
let recentWorkspaceIds = [];
let sessionsValid = true;
let sourceErrors = [];
let taskBackendAvailable = true;
let delaySendMs = 0;
let delayAttachMs = 0;
let delayTasksMs = 0;
let delayActionMs = 0;
let delaySnapshotMs = 0;
let delayStateListMs = 0;
let stateListFailures = 0;
let stateOpportunitiesFailures = 0;
let uploadFailures = 0;
let loseMailResponseOnce = false;
const sentRequestIds = new Map();
let freshWorkspace = false;
let agentJoined = false;
let resourceLinks = [];
let plugins = [
  { id: "core", version: "0.2.0", name: "Core", description: "Workspace records and resources.", required: true, attached: true },
  { id: "chat", version: "0.2.0", name: "Chat", description: "Conversations for participants.", required: true, attached: true },
  { id: "tasks", version: "0.2.0", name: "Tasks", description: "Workspace task store.", required: false, attached: true },
  { id: "state", version: "0.2.0", name: "State", description: "Agent-managed state markers.", required: false, attached: true },
];
let markers = [{ id: "marker-1", title: "Fixture release", definition_id: "release", definition_version: "1", state: "draft", revision: 1, subject: { kind: "task", workspace_id: "workspace-1", store_id: "default", task_id: "fixture-1" }, created_by: "alice" }];
let stateDefinition = { id: "release", version: "1", label: "Release", states: ["draft", "review", "shipped"], initial: "draft", transitions: [{ from: "draft", to: "review" }, { from: "review", to: "shipped" }] };
let tasks = [{ id: "fixture-1", task_id: "fixture-1", title: "Fixture task", status: "open", priority: 2, description: "Fixture task description" }];
const messages = [
  { id: "general-1", sender_id: "alice", destination: { kind: "channel", id: "general" }, body: "General fixture message\nhttps://example.com/docs and /w/workspace-1/files/fixture-root?path=README.md\n```sh\nprintf 'https://example.com/plain-code'\n```", kind: "message" },
  { id: "direct-1", sender_id: "owner", destination: { kind: "direct", id: "alice" }, body: "Owner to Alice", kind: "message" },
  { id: "direct-2", sender_id: "alice", destination: { kind: "direct", id: "owner" }, body: "Alice to Owner", kind: "message" },
  { id: "direct-3", sender_id: "alice", destination: { kind: "direct", id: "orchard" }, body: "Agent to agent", kind: "decision" },
  { id: "broadcast-1", sender_id: "owner", destination: { kind: "broadcast" }, body: "Broadcast fixture message", kind: "result" },
];
const calls = [];
const artifactFiles = {
  "README.md": { text: "# Fixture heading\n\n**Bold** text.\n\n- [Code](docs/example.py)\n- [Outside](../../escape.txt)\n\n```js\nconsole.log('fixture')\n```", mime_type: "text/markdown", download_url: "/fixture/download/README.md" },
  "docs/example.py": { text: "print('fixture')\n", mime_type: "text/x-python" },
  "image.png": { text: null, binary: true, byte_length: 4, mime_type: "image/png", preview_url: "/fixture/image.png", download_url: "/fixture/download/image.png" },
  "empty.txt": { text: "", byte_length: 0, mime_type: "text/plain", download_url: "/fixture/download/empty.txt" },
};
const initialArtifactFiles = structuredClone(artifactFiles);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subscribers = new Set();
let revision = 0;

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]), payload]);
}
function emitChange(topics, workspaceId = workspace.id) {
  revision += 1;
  for (const client of subscribers) if (client.workspaceId === workspaceId) client.socket.write(frame({ type: "changed", workspace_id: workspaceId, revision, topics }));
}

function resetFixture() {
  for (const client of subscribers) client.socket.end(); subscribers.clear(); revision = 0;
  buildIdentity = structuredClone(initialBuildIdentity);
  for (const path of Object.keys(artifactFiles)) delete artifactFiles[path];
  Object.assign(artifactFiles, structuredClone(initialArtifactFiles));
  created = false; workspaces = []; recentWorkspaceIds = []; sessionsValid = true; sourceErrors = []; taskBackendAvailable = true;
  repositories = []; delaySendMs = 0; delayAttachMs = 0; delayTasksMs = 0; delaySnapshotMs = 0; delayStateListMs = 0; stateListFailures = 0; stateOpportunitiesFailures = 0;
  delayActionMs = 0; uploadFailures = 0; resourceLinks = [];
  loseMailResponseOnce = false; sentRequestIds.clear(); freshWorkspace = false; agentJoined = false;
  plugins = structuredClone([{ id: "core", version: "0.2.0", name: "Core", description: "Workspace records and resources.", required: true, attached: true }, { id: "chat", version: "0.2.0", name: "Chat", description: "Conversations for participants.", required: true, attached: true }, { id: "tasks", version: "0.2.0", name: "Tasks", description: "Workspace task store.", required: false, attached: true }, { id: "state", version: "0.2.0", name: "State", description: "Agent-managed state markers.", required: false, attached: true }]);
  markers = [{ id: "marker-1", title: "Fixture release", definition_id: "release", definition_version: "1", state: "draft", revision: 1, subject: { kind: "task", workspace_id: "workspace-1", store_id: "default", task_id: "fixture-1" }, created_by: "alice" }];
  stateDefinition = { id: "release", version: "1", label: "Release", states: ["draft", "review", "shipped"], initial: "draft", transitions: [{ from: "draft", to: "review" }, { from: "review", to: "shipped" }] };
  tasks = [{ id: "fixture-1", task_id: "fixture-1", title: "Fixture task", status: "open", priority: 2, description: "Fixture task description" }];
  calls.splice(0, calls.length);
  messages.splice(5);
}

const send = (response, status, body, headers = {}) => response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
const bodyOf = async (request) => new Promise((resolve, reject) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(error); } });
});

function snapshot(workspaceId = workspace.id) {
  const stores = [{ store: taskStore, tasks }, ...repositories.filter((repository) => repository.task_store_id).map(() => ({ store: projectStore, tasks: [] }))];
  const selected = workspaces.find((item) => item.id === workspaceId) || workspace;
  const joining = freshWorkspace && !agentJoined;
  return { workspace: { ...selected, repositories, task_stores: stores.map((item) => item.store) }, mail: { participants: joining ? participants.slice(0, 1) : participants, channels, history: joining ? [] : messages }, task_stores: stores, plugins, errors: sourceErrors };
}

function history(args) {
  let result = messages.filter((entry) => !args.destination_kind || entry.destination.kind === args.destination_kind);
  if (args.channel_id) result = result.filter((entry) => entry.destination.id === args.channel_id);
  return { messages: result };
}

async function staticFile(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(requested).replace(/^\.\.([/\\]|$)/, "");
  try {
    const contents = await readFile(new URL(safe, dist));
    const type = extname(safe) === ".js" ? "text/javascript" : extname(safe) === ".css" ? "text/css" : "text/html";
    response.writeHead(200, { "content-type": type }).end(contents);
  } catch {
    response.writeHead(200, { "content-type": "text/html" }).end(await readFile(new URL("index.html", dist)));
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const authenticated = sessionsValid && (request.headers.cookie?.includes("orchard_session=fixture") || false);
  if (url.pathname === "/api/build" && request.method === "GET") return send(response, 200, buildIdentity, { "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  if (url.pathname === "/api/session" && request.method === "GET") return send(response, 200, { authenticated });
  if (url.pathname === "/api/session" && request.method === "POST") {
    const payload = await bodyOf(request);
    if (payload.token !== undefined && payload.token !== "fixture-access-key") return send(response, 401, { error: "The access key was not accepted." });
    sessionsValid = true;
    return send(response, 200, { authenticated: true }, { "set-cookie": "orchard_session=fixture; HttpOnly; SameSite=Strict; Path=/api" });
  }
  if (url.pathname === "/api/call" && request.method === "POST") {
    if (!authenticated) return send(response, 401, { error: "Authentication required." });
    const payload = await bodyOf(request);
    const args = payload.args || {};
    calls.push({ operation: payload.operation, args });
    if (payload.operation === "workspace_list") return send(response, 200, { result: { workspaces: [archivedWorkspace, ...workspaces], recent_workspace_ids: recentWorkspaceIds } });
    if (payload.operation === "workspace_create") { created = true; const createdWorkspace = { id: `workspace-${workspaces.length + 1}`, name: args.name || `Workspace ${workspaces.length + 1}`, ...(args.purpose ? { purpose: args.purpose } : {}) }; workspaces.push(createdWorkspace); recentWorkspaceIds = [createdWorkspace.id, ...recentWorkspaceIds.filter((id) => id !== createdWorkspace.id)].slice(0, 20); return send(response, 200, { result: { workspace: createdWorkspace } }); }
    if (payload.operation === "workspace_visit") { const selected = workspaces.find((item) => item.id === args.workspace_id); if (!selected) return send(response, 400, { error: "Unknown or archived workspace." }); recentWorkspaceIds = [selected.id, ...recentWorkspaceIds.filter((id) => id !== selected.id)].slice(0, 20); return send(response, 200, { result: { workspace_id: selected.id } }); }
    if (payload.operation === "workspace_archive") { const selected = workspaces.find((item) => item.id === args.workspace_id) || workspace; workspaces = workspaces.filter((item) => item.id !== args.workspace_id); created = workspaces.length > 0; return send(response, 200, { result: { workspace: { ...selected, archived: true } } }); }
    if (payload.operation === "workspace_snapshot") { if (delaySnapshotMs) await sleep(delaySnapshotMs); return send(response, 200, { result: snapshot(args.workspace_id) }); }
    if (payload.operation === "plugin_attach" || payload.operation === "plugin_detach") { const item = plugins.find((entry) => entry.id === args.plugin_id); if (!item || item.required) return send(response, 400, { error: "Plugin cannot be changed" }); item.attached = payload.operation === "plugin_attach"; emitChange(["plugins", args.plugin_id === "state" ? "state" : "tasks"], args.workspace_id); return send(response, 200, { result: { plugin: item } }); }
    if (payload.operation === "plugin_list") return send(response, 200, { result: { plugins } });
    if (payload.operation === "state_list") { if (stateListFailures > 0) { stateListFailures -= 1; return send(response, 503, { error: "Fixture State store is unavailable" }); } const listed = structuredClone(args.workspace_id === workspace.id ? markers : []); if (delayStateListMs) await sleep(delayStateListMs); return send(response, 200, { result: { markers: listed } }); }
    if (payload.operation === "state_opportunities") { if (stateOpportunitiesFailures > 0) { stateOpportunitiesFailures -= 1; return send(response, 503, { error: "Fixture opportunities are unavailable" }); } const marker = markers.find((entry) => entry.id === "marker-1"); return send(response, 200, { result: { opportunities: args.workspace_id === workspace.id && marker ? [{ marker, resource: marker.subject, guidance: { instructions: "Collect the release evidence before advancing.", capabilities: ["release-review"] }, task: tasks[0], transitions: marker.state === "draft" ? [{ from: "draft", to: "review", label: "Send to review", readiness: "needs_input", reasons: ["Attach the release checklist."], prerequisites: [{ kind: "reference", resource_kind: "file" }] }] : [{ from: "review", to: "shipped", label: "Mark shipped", readiness: "ready", reasons: [], prerequisites: [{ kind: "subject_task_closed" }] }] }] : [] } }); }
    if (payload.operation === "state_get") { const marker = markers.find((entry) => entry.id === args.id); return marker ? send(response, 200, { result: { marker, definition: stateDefinition, history: [{ from: "draft", to: "draft", actor: "alice" }], available_transitions: marker.state === "draft" ? [{ from: "draft", to: "review", label: "Send to review" }] : [{ from: "review", to: "shipped", label: "Mark shipped" }], attached: plugins.find((item) => item.id === "state")?.attached } }) : send(response, 404, { error: "Marker not found" }); }
    if (payload.operation === "state_advance") { const marker = markers.find((entry) => entry.id === args.id); if (!marker || marker.revision !== args.expected_revision) return send(response, 409, { error: "State marker changed; refresh before trying again." }); marker.state = args.to; marker.revision += 1; emitChange(["state"], args.workspace_id); return send(response, 200, { result: { marker } }); }
    if (payload.operation === "workspace_info") return send(response, 200, { result: { workspace: workspaces.find((item) => item.id === args.workspace_id) || workspace, paths: { workspace: `/private/tmp/orchard-fixture-workspaces/${args.workspace_id}`, artifacts: `/private/tmp/orchard-fixture-workspaces/${args.workspace_id}/artifacts`, readme: `/private/tmp/orchard-fixture-workspaces/${args.workspace_id}/artifacts/README.md` } } });
    if (payload.operation === "workspace_intro") {
      const ref = { kind: "file", workspace_id: args.workspace_id, root_id: "fixture-root", path: "README.md" };
      return send(response, 200, { result: { readme: { ref, href: `/w/${encodeURIComponent(args.workspace_id)}/files/fixture-root?path=README.md`, path: "README.md", text: artifactFiles["README.md"].text, exists: true }, participants: freshWorkspace && !agentJoined ? participants.slice(0, 1) : participants, channels, introduction: "Fixture collaborators share this workspace through Orchard. Read the README for the working agreement and current context.", joining_prompt: `Use the configured Orchard MCP for workspace ${args.workspace_id}. Call workspace_intro, register or resume your participant, check alerts, and acknowledge inbox messages as you work.` } });
    }
    if (payload.operation === "resource_get") {
      const ref = args.ref || {}; const kind = ref.kind;
      const descriptor = (title, data) => ({ ref, href: `/w/${encodeURIComponent(args.workspace_id)}/${kind === "channel" ? "channels" : kind === "direct" ? "direct" : kind === "broadcast" ? "broadcast" : `${kind}s`}/${ref.id || ""}`.replace(/\/$/, ""), title, kind, data });
      const links = { outgoing: resourceLinks.filter((entry) => JSON.stringify(entry.source) === JSON.stringify(ref)), incoming: resourceLinks.filter((entry) => JSON.stringify(entry.target) === JSON.stringify(ref)) };
      if (kind === "channel") return send(response, 200, { result: { resource: descriptor(ref.id, { channel: channels.find((entry) => entry.id === ref.id), messages: messages.filter((entry) => entry.destination.kind === "channel" && entry.destination.id === ref.id) }), links } });
      if (kind === "direct") return send(response, 200, { result: { resource: descriptor(ref.id, { participant: participants.find((entry) => entry.id === ref.id), messages: messages.filter((entry) => entry.destination.kind === "direct") }), links } });
      if (kind === "broadcast") return send(response, 200, { result: { resource: descriptor("Broadcast", { messages: messages.filter((entry) => entry.destination.kind === "broadcast") }), links } });
      if (kind === "message") { const record = messages.find((entry) => entry.id === ref.id); return record ? send(response, 200, { result: { resource: descriptor("Message", { message: record }), links } }) : send(response, 404, { error: "Message not found" }); }
      if (kind === "agent") return send(response, 200, { result: { resource: descriptor(ref.id, { participant: participants.find((entry) => entry.id === ref.id) }), links } });
      if (kind === "task") { const task = tasks.find((entry) => entry.id === ref.task_id); return task ? send(response, 200, { result: { resource: descriptor(task.title, { task, dependencies: [] }), links } }) : send(response, 404, { error: "Task not found" }); }
      if (kind === "state") { const marker = markers.find((entry) => entry.id === ref.id); return marker ? send(response, 200, { result: { resource: descriptor(marker.title, { marker, definition: stateDefinition, guidance: { instructions: "Collect the release evidence before advancing.", capabilities: ["release-review"] }, task: tasks[0], history: [{ from: "draft", to: "draft", actor: "alice" }], available_transitions: marker.state === "draft" ? [{ from: "draft", to: "review", label: "Send to review", readiness: "needs_input", reasons: ["Attach the release checklist."], prerequisites: [{ kind: "reference", resource_kind: "file" }] }] : [{ from: "review", to: "shipped", label: "Mark shipped", readiness: "ready", reasons: [], prerequisites: [{ kind: "subject_task_closed" }] }], attached: plugins.find((item) => item.id === "state")?.attached }), links } }) : send(response, 404, { error: "Marker not found" }); }
      if (kind === "file") { const file = artifactFiles[ref.path]; return file ? send(response, 200, { result: { resource: descriptor(ref.path, file), links } }) : send(response, 404, { error: "File not found" }); }
      if (kind === "url") return send(response, 200, { result: { resource: descriptor(ref.url, { url: ref.url }), links } });
    }
    if (payload.operation === "artifact_roots") return send(response, 200, { result: { roots: [{ id: "fixture-root", name: "Fixture artifacts", owned: true, exists: true }] } });
    if (payload.operation === "artifact_list") { const path = args.path || ""; const entries = path ? [{ name: "example.py", path: "docs/example.py", kind: "file" }, { name: "module", path: "docs/module", kind: "submodule" }] : [{ name: "README.md", path: "README.md", kind: "file" }, { name: "docs", path: "docs", kind: "directory" }, { name: "image.png", path: "image.png", kind: "file" }, { name: "empty.txt", path: "empty.txt", kind: "file" }]; return send(response, 200, { result: { entries } }); }
    if (payload.operation === "artifact_history") return send(response, 200, { result: { versions: [{ revision: "0123456789abcdef0123456789abcdef01234567", summary: "Fixture version" }] } });
    if (payload.operation === "resource_link") { if (delayActionMs) await sleep(delayActionMs); const link = { source: args.source, target: args.target, label: args.label || "" }; resourceLinks.push(link); emitChange(["artifacts"], args.workspace_id); return send(response, 200, { result: { link } }); }
    if (payload.operation === "artifact_upload") { if (delayAttachMs) await sleep(delayAttachMs); if (uploadFailures > 0) { uploadFailures -= 1; return send(response, 503, { error: "Fixture upload failed once" }); } const revision = "0123456789abcdef0123456789abcdef01234567"; artifactFiles[args.path] = { text: Buffer.from(args.content_base64 || "", "base64").toString("utf8"), mime_type: "text/plain", download_url: `/fixture/download/${encodeURIComponent(args.path)}` }; emitChange(["artifacts"], args.workspace_id); return send(response, 200, { result: { resource: { ref: { kind: "file", workspace_id: args.workspace_id, root_id: "fixture-root", path: args.path, revision }, href: `/w/${args.workspace_id}/files/fixture-root?path=${encodeURIComponent(args.path)}&revision=${revision}`, title: args.path, kind: "file" }, revision } }); }
    if (payload.operation === "repository_attach") {
      if (delayAttachMs) await sleep(delayAttachMs);
      const isPlain = args.path.includes("plain");
      const repository = { id: `project-${repositories.length + 1}`, path: args.path, name: args.path.split("/").filter(Boolean).at(-1), task_store_id: isPlain ? null : projectStore.id, task_status: isPlain ? "none" : "linked", task_error: null, git: { available: true, branch: "main", head: "0123456789abcdef0123456789abcdef01234567", dirty: 0 } };
      repositories = [...repositories, repository];
      emitChange(["repositories", "tasks", "artifacts"], args.workspace_id);
      return send(response, 200, { result: { repository, task_store: isPlain ? null : projectStore, attached: true, task_store_attached: !isPlain } });
    }
    if (payload.operation === "tasks_list") { if (delayTasksMs) await sleep(delayTasksMs); return send(response, 200, { result: { tasks } }); }
    if (payload.operation === "task_create") { const task = { id: `fixture-${tasks.length + 1}`, task_id: `fixture-${tasks.length + 1}`, title: args.title, status: "open", description: "" }; tasks.push(task); emitChange(["tasks"], args.workspace_id); return send(response, 200, { result: { task } }); }
    if (payload.operation === "task_update") { if (delayActionMs) await sleep(delayActionMs); const task = tasks.find((entry) => entry.id === args.task_id); if (task) task.status = args.status; emitChange(["tasks"], args.workspace_id); return send(response, 200, { result: { task } }); }
    if (payload.operation === "task_claim") { const task = tasks.find((entry) => entry.id === args.task_id); if (!task || task.status !== "open" || task.assignee) return send(response, 409, { error: "Task is not available to claim" }); task.assignee = args.participant_id; emitChange(["tasks"], args.workspace_id); return send(response, 200, { result: { task } }); }
    if (payload.operation === "task_close") { const task = tasks.find((entry) => entry.id === args.task_id); if (task) task.status = "closed"; emitChange(["tasks"], args.workspace_id); return send(response, 200, { result: { task } }); }
    if (payload.operation === "task_show") return send(response, 200, { result: { task: tasks.find((entry) => entry.id === args.task_id) } });
    if (payload.operation === "task_dependencies") return send(response, 200, { result: { dependencies: [] } });
    if (payload.operation === "mail_history") return send(response, 200, { result: history(args) });
    if (payload.operation === "mail_send") {
      if (delaySendMs) await sleep(delaySendMs);
      const existing = sentRequestIds.get(args.request_id);
      if (existing) return JSON.stringify(existing.args) === JSON.stringify(args) ? send(response, 200, { result: { message: existing.message } }) : send(response, 409, { error: "Request ID reused with different content" });
      const sent = { id: `sent-${messages.length}`, sender_id: args.sender_id, destination: args.destination, body: args.body, kind: args.kind, thread_id: args.thread_id, refs: args.refs };
      messages.push(sent); sentRequestIds.set(args.request_id, { args, message: sent }); emitChange(["mail"], args.workspace_id);
      if (loseMailResponseOnce) { loseMailResponseOnce = false; return send(response, 503, { error: "Message accepted, but response was lost" }); }
      return send(response, 200, { result: { message: sent } });
    }
    if (payload.operation === "connection_info") return send(response, 200, { result: { endpoint: "http://127.0.0.1:4174/workspaces/workspace-1/mcp", token: "fixture-mcp-token" } });
    if (payload.operation === "settings_get") return send(response, 200, { result: { config: { task_backend: taskBackendAvailable ? { available: true } : { available: false, error: "Fixture Beads binary is unavailable" } } } });
    return send(response, 200, { result: {} });
  }
  if (url.pathname === "/fixture/audit") return send(response, 200, { calls, messages });
  if (url.pathname === "/fixture/long-history" && request.method === "POST") {
    for (let index = 0; index < 40; index += 1) messages.push({ id: `long-${index}`, sender_id: "alice", destination: { kind: "channel", id: "general" }, body: `Long history ${index}`, kind: "message" });
    return send(response, 200, { ok: true });
  }
  if (url.pathname === "/fixture/reset" && request.method === "POST") { resetFixture(); return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/build" && request.method === "POST") { buildIdentity = await bodyOf(request); return send(response, 200, { buildIdentity }); }
  if (url.pathname === "/fixture/drop-events" && request.method === "POST") { for (const client of subscribers) client.socket.end(); subscribers.clear(); return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/delay" && request.method === "POST") { const value = await bodyOf(request); delaySendMs = Number(value.send || 0); delayAttachMs = Number(value.attach || 0); delayTasksMs = Number(value.tasks || 0); delayActionMs = Number(value.action || 0); delaySnapshotMs = Number(value.snapshot || 0); delayStateListMs = Number(value.state_list || 0); return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/fail-upload-once" && request.method === "POST") { uploadFailures = 1; return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/fail-state-list" && request.method === "POST") { stateListFailures = 1; return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/fail-state-opportunities" && request.method === "POST") { stateOpportunitiesFailures = 1; return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/lose-mail-response-once" && request.method === "POST") { loseMailResponseOnce = true; return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/fresh-workspace" && request.method === "POST") { freshWorkspace = true; return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/agent-contact" && request.method === "POST") { agentJoined = true; emitChange(["mail"]); return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/state-definition" && request.method === "POST") { const value = await bodyOf(request); stateDefinition = value.definition || stateDefinition; emitChange(["state"]); return send(response, 200, { ok: true }); }
  if (url.pathname === "/fixture/external-change" && request.method === "POST") {
    const value = await bodyOf(request);
    if (value.task_status) tasks[0].status = value.task_status;
    if (value.task_assignee !== undefined) tasks[0].assignee = value.task_assignee;
    if (value.file_text) artifactFiles["README.md"] = { ...artifactFiles["README.md"], text: value.file_text };
    if (value.message) messages.push({ id: `external-${messages.length}`, sender_id: "alice", destination: { kind: "channel", id: "general" }, body: value.message, kind: "message" });
    if (value.mail_message && typeof value.mail_message === "object") messages.push({ id: `external-${messages.length}`, sender_id: "alice", destination: { kind: "channel", id: "general" }, body: "Fixture message", kind: "message", ...value.mail_message });
    if (value.repository_git && repositories[0]) repositories[0].git = { ...repositories[0].git, ...value.repository_git };
    if (value.marker_state) { markers[0].state = value.marker_state; markers[0].revision += 1; }
    emitChange(value.topics || (value.repository_git ? ["repositories"] : ["tasks", "mail"]), value.workspace_id || workspace.id);
    return send(response, 200, { ok: true });
  }
  if (url.pathname === "/fixture/revoke" && request.method === "POST") { sessionsValid = false; for (const client of subscribers) client.socket.end(); subscribers.clear(); return send(response, 200, { revoked: true }); }
  if (url.pathname === "/fixture/source-error" && request.method === "POST") { sourceErrors = [{ source: "task_store", error: "Fixture backend is unavailable" }]; return send(response, 200, { errors: sourceErrors }); }
  if (url.pathname === "/fixture/task-backend-down" && request.method === "POST") { taskBackendAvailable = false; return send(response, 200, { available: false }); }
  return staticFile(url.pathname, response);
});

server.listen(port, "127.0.0.1", () => console.log(`Orchard fixture http://127.0.0.1:${port}`));
server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = /^\/api\/workspaces\/([^/]+)\/events$/.exec(url.pathname);
  const workspaceId = match ? decodeURIComponent(match[1]) : "";
  const origin = `http://${request.headers.host}`;
  if (!sessionsValid || !request.headers.cookie?.includes("orchard_session=fixture") || request.headers.origin !== origin || !workspaces.some((item) => item.id === workspaceId) || !request.headers["sec-websocket-key"]) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { socket, workspaceId }; subscribers.add(client);
  socket.write(frame({ type: "hello", workspace_id: workspaceId, revision }));
  socket.on("close", () => subscribers.delete(client));
  socket.on("error", () => subscribers.delete(client));
});
