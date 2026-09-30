#!/usr/bin/env node
/** Compact, local-only State examples. No provider calls, review, or deployment. */
import { readFile, rename, writeFile } from "node:fs/promises";

const defaultUrl = "http://127.0.0.1:64652";
const args = process.argv.slice(2);
const command = args.find((value) => !value.startsWith("--")) || "seed";
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const manifestPath = option("--manifest", "/private/tmp/orchard-state-demos.json");
const origin = new URL(option("--url", defaultUrl));
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(origin.hostname)) {
  throw new Error("--url must be an http loopback URL");
}

let cookie = "";
async function request(path, init = {}) {
  const response = await fetch(new URL(path, origin), { ...init, headers: { Origin: origin.origin, Host: origin.host, Cookie: cookie, "content-type": "application/json", ...(init.headers || {}) } });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${init.method || "GET"} ${path}: ${body.error || response.status}`);
  return body.result ?? body;
}
async function call(operation, args = {}) { return request("/api/call", { method: "POST", body: JSON.stringify({ operation, args }) }); }
async function session() { await request("/api/session", { method: "POST", body: "{}" }); }
async function loadManifest() { try { return JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) { if (error.code === "ENOENT") return { version: 1, demos: {} }; throw error; } }
async function saveManifest(manifest) { const temporary = `${manifestPath}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); await rename(temporary, manifestPath); }
const id = (demo, action) => `state-demo-${demo}-${action}-v1`;
const ref = (workspace_id, kind, values) => ({ kind, workspace_id, ...values });

const demos = {
  proposal: {
    name: "SCRIPTED DEMO — Proposal review",
    purpose: "A scripted proposal review and rework example; no independent review occurred.",
    flow: { id: "proposal-review", version: 1, label: "Scripted proposal review", states: ["draft", "review", "rework", "approved"], initial: "draft", transitions: [{ from: "draft", to: "review", label: "request review" }, { from: "review", to: "rework", label: "request revision" }, { from: "rework", to: "review", label: "resubmit" }, { from: "review", to: "approved", label: "approve" }] },
    artifact: ["proposal/brief.md", "# Proposal: daily listening digest\n\n## First draft\nA weekly digest with a short listening summary.\n\n## Next transition\nScripted Demo Reviewer moves the task-backed marker from review to rework after checking this pinned first draft.\n"],
    revisedArtifact: "# Proposal: daily listening digest\n\n## Revised draft\nKeep the weekly digest and add a human-readable source list beside each summary.\n\n## Next transition\nScripted Demo Author has resubmitted this pinned revision for review.\n",
    tasks: [["Check the scope note", "Read the pinned proposal and leave the one concrete rework note."]],
    marker: "proposal-daily-listening-digest",
    title: "Daily listening digest proposal",
    actors: [["scripted-demo-author", "Scripted Demo Author"], ["scripted-demo-reviewer", "Scripted Demo Reviewer"]],
    subject: "task",
    steps: [{ to: "review", actor: "scripted-demo-author", note: "Scripted Demo Author requested review of the pinned first-draft Markdown proposal.", references: ["artifact", "task"] }, { to: "rework", actor: "scripted-demo-reviewer", note: "Scripted Demo Reviewer requested one revision: retain a source list beside the digest.", references: ["artifact", "task"] }, { to: "review", actor: "scripted-demo-author", note: "Scripted Demo Author resubmitted the separately pinned revised draft after adding the source-list decision.", references: ["revised-artifact", "task"], revisedArtifact: true }]
  },
  release: {
    name: "SCRIPTED DEMO — Release readiness",
    purpose: "A scripted release-readiness board; every release action is simulated and no deployment occurred.",
    flow: { id: "release-readiness", version: 1, label: "Scripted release readiness", states: ["planning", "gated", "blocked", "ready", "simulated-release"], initial: "planning", transitions: [{ from: "planning", to: "gated", label: "open gates" }, { from: "gated", to: "blocked", label: "block on gate" }, { from: "blocked", to: "ready", label: "clear gate" }, { from: "ready", to: "simulated-release", label: "simulate release" }] },
    artifact: ["release/readiness.md", "# Release readiness (scripted)\n\n- Gate: accessibility sign-off is intentionally blocked in this demo.\n- Deployment: simulated only; this workspace never deploys anything.\n\n## Next transition\nAfter the scripted gate task is resolved, move the marker from blocked to ready.\n"],
    tasks: [["Scripted gate: accessibility sign-off", "Blocked gate for the demo. Resolve only as a simulation before the simulated release."], ["Prepare simulated release notes", "Draft the summary linked to the readiness marker; do not deploy."]],
    marker: "release-0-2-readiness",
    title: "v0.2 release readiness (simulated)",
    actors: [["scripted-demo-author", "Scripted Demo Author"], ["scripted-demo-release-coordinator", "Scripted Demo Release Coordinator"]],
    steps: [{ to: "gated", actor: "scripted-demo-release-coordinator", note: "Scripted Demo Release Coordinator opened the task-linked readiness gates.", references: ["artifact", "task"] }, { to: "blocked", actor: "scripted-demo-release-coordinator", note: "Blocked: the linked Beads accessibility-sign-off gate is marked blocked; no deployment is attempted.", references: ["artifact", "task"], taskStatus: "blocked" }, { to: "ready", actor: "scripted-demo-release-coordinator", note: "Simulated gate completion only: the linked Beads task is closed as fixture evidence.", references: ["artifact", "task"], taskStatus: "closed" }, { to: "simulated-release", actor: "scripted-demo-release-coordinator", note: "Simulated release recorded. No deployment or independent release approval occurred.", references: ["artifact", "task"] }]
  },
  creative: {
    name: "SCRIPTED DEMO — Creative brief",
    purpose: "A scripted creative-brief handoff example; alternatives are fixtures, not independent creative review.",
    flow: { id: "creative-handoff", version: 1, label: "Scripted creative handoff", states: ["briefing", "alternatives", "selected", "handoff"], initial: "briefing", transitions: [{ from: "briefing", to: "alternatives", label: "generate alternatives" }, { from: "alternatives", to: "selected", label: "select direction" }, { from: "selected", to: "handoff", label: "handoff" }] },
    artifact: ["creative/brief.md", "# Creative brief: orchard listening cards\n\n## Alternatives\n1. Quiet field notes: dense type and minimal color.\n2. Night orchard: a strong citron accent around playback state.\n\n## Handoff\nThe selected direction is a scripted fixture. Link this pinned brief and the handoff task before moving to handoff.\n"],
    tasks: [["Choose a scripted direction", "Select one fixture alternative and record why in the State history."], ["Hand off the pinned brief", "Link the selected brief to the scripted design handoff."]],
    marker: "creative-orchard-listening-cards",
    title: "Orchard listening-card creative brief",
    actors: [["scripted-demo-author", "Scripted Demo Author"], ["scripted-demo-creative-lead", "Scripted Demo Creative Lead"], ["scripted-demo-handoff", "Scripted Demo Handoff"]],
    steps: [{ to: "alternatives", actor: "scripted-demo-creative-lead", note: "Scripted Demo Creative Lead recorded two fixture alternatives in the pinned brief.", references: ["artifact"] }, { to: "selected", actor: "scripted-demo-creative-lead", note: "Selected Night orchard as a scripted direction for the handoff example.", references: ["artifact", "task"], taskIndex: 0, taskStatus: "closed" }, { to: "handoff", actor: "scripted-demo-handoff", note: "Scripted Demo Handoff linked the selected pinned brief and handoff task. No independent creative review occurred.", references: ["artifact", "task"], taskIndex: 1, taskStatus: "closed" }]
  }
};

async function ensureDemo(manifest, key, demo) {
  let saved = manifest.demos[key];
  if (!saved) {
    manifest.demos[key] = { creating: true, name: demo.name };
    await saveManifest(manifest);
    const created = await call("workspace_create", { name: demo.name, purpose: demo.purpose, owner_name: "Scripted Demo Owner" });
    saved = manifest.demos[key] = { workspace_id: created.workspace.id, store_id: created.workspace.task_stores[0].id, steps: 0 };
    await saveManifest(manifest);
  } else if (saved.creating && !saved.workspace_id) {
    throw new Error(`workspace creation for ${key} has an unknown outcome; inspect workspace_list and repair ${manifestPath} with the returned workspace/store IDs before retrying`);
  }
  const workspace_id = saved.workspace_id;
  await call("plugin_attach", { workspace_id, plugin_id: "state", request_id: id(key, "attach") });
  for (const [participant_id, name] of demo.actors) await call("mail_register", { workspace_id, participant_id, name, request_id: id(key, `register-${participant_id}`) });
  await call("state_define", { workspace_id, participant_id: "scripted-demo-author", request_id: id(key, "define"), definition: demo.flow });
  const upload = await call("artifact_upload", { workspace_id, path: demo.artifact[0], content_base64: Buffer.from(demo.artifact[1]).toString("base64"), request_id: id(key, "artifact-v2") });
  const artifact = upload.resource.ref;
  saved.artifact = artifact;
  for (let index = 0; index < demo.tasks.length; index++) {
    const [title, description] = demo.tasks[index];
    const result = await call("task_create", { workspace_id, store_id: saved.store_id, request_id: id(key, `task-${index + 1}`), title, description, labels: ["scripted-demo", `state-demo:${key}`] });
    const task = result.task;
    (saved.tasks ||= [])[index] = ref(workspace_id, "task", { store_id: saved.store_id, task_id: task.id || task.task_id });
  }
  await call("state_create", { workspace_id, participant_id: "scripted-demo-author", request_id: id(key, "marker"), id: demo.marker, title: demo.title, definition_id: demo.flow.id, definition_version: demo.flow.version, subject: demo.subject === "task" ? saved.tasks[0] : artifact });
  saved.marker = demo.marker;
  const workflow = demo.flow.transitions.map((edge) => `${edge.from} → ${edge.to}`).join("; ");
  const readme = `# ${demo.name}\n\n${demo.purpose}\n\n## Bounded work\n- State marker: [${demo.marker}](/w/${workspace_id}/states/${demo.marker})\n- Pinned working artifact: \`${demo.artifact[0]}\`\n- Tasks: ${saved.tasks.map((task) => `\`${task.task_id}\``).join(", ")}\n\n## Workflow\n${workflow}\n\nOpen the State marker for its current state, history, references, and declared next transitions. State's browser viewer is read-only; a scripted agent/API call moves this marker. No real independent review or deployment occurred.\n`;
  const readmeUpload = await call("artifact_upload", { workspace_id, path: "README.md", content_base64: Buffer.from(readme).toString("base64"), request_id: id(key, "readme-v2") });
  saved.readme = readmeUpload.resource.ref;
  await call("resource_link", { workspace_id, request_id: id(key, "marker-artifact-link-v2"), source: ref(workspace_id, "state", { id: demo.marker }), target: artifact, label: "Pinned scripted-demo artifact" });
  await call("resource_link", { workspace_id, request_id: id(key, "readme-marker-link-v2"), source: saved.readme, target: ref(workspace_id, "state", { id: demo.marker }), label: "Scripted-demo State marker" });
  await call("resource_link", { workspace_id, request_id: id(key, "readme-artifact-link-v2"), source: saved.readme, target: artifact, label: "Pinned working artifact" });
  await call("resource_link", { workspace_id, request_id: id(key, "readme-task-link-v2"), source: saved.readme, target: saved.tasks[0], label: "Bounded task" });
  if (key === "proposal") {
    await call("mail_channel_create", { workspace_id, request_id: id(key, "comments-channel"), channel_id: "proposal-comments", name: "Proposal comments", description: "Scripted comments for the State proposal demo." });
    await call("mail_send", { workspace_id, request_id: id(key, "review-comment"), sender_id: "scripted-demo-reviewer", destination: { kind: "channel", id: "proposal-comments" }, kind: "comment", body: "Scripted demo comment: please retain a source list beside each digest summary before resubmitting.", refs: [{ type: "task", store_id: saved.store_id, task_id: saved.tasks[0].task_id }] });
  }
  await saveManifest(manifest);
  return saved;
}
async function advance(manifest, key, demo, count = 1) {
  const saved = await ensureDemo(manifest, key, demo);
  for (let remaining = 0; remaining < count && saved.steps < demo.steps.length; remaining++) {
    const step = demo.steps[saved.steps];
    const current = await call("state_get", { workspace_id: saved.workspace_id, id: saved.marker });
    const expectedState = saved.steps === 0 ? demo.flow.initial : demo.steps[saved.steps - 1].to;
    if (current.marker.revision !== saved.steps + 1 || current.marker.state !== expectedState) {
      throw new Error(`marker ${saved.marker} no longer matches scripted progress; stop the runner and use the agent/API flow instead`);
    }
    if (step.revisedArtifact && !saved.revised_artifact) {
      const revised = await call("artifact_upload", { workspace_id: saved.workspace_id, path: demo.artifact[0], content_base64: Buffer.from(demo.revisedArtifact).toString("base64"), request_id: id(key, "artifact-revised") });
      saved.revised_artifact = revised.resource.ref;
      await call("resource_link", { workspace_id: saved.workspace_id, request_id: id(key, "marker-revised-artifact-link"), source: ref(saved.workspace_id, "state", { id: saved.marker }), target: saved.revised_artifact, label: "Pinned scripted-demo revised artifact" });
    }
    const task = saved.tasks[step.taskIndex || 0];
    const references = step.references.map((which) => which === "artifact" ? saved.artifact : which === "revised-artifact" ? saved.revised_artifact : task);
    if (step.taskStatus) await call("task_update", { workspace_id: saved.workspace_id, store_id: saved.store_id, task_id: task.task_id, request_id: id(key, `gate-${saved.steps + 1}`), status: step.taskStatus });
    saved.pending_transition = { workspace_id: saved.workspace_id, participant_id: step.actor, request_id: id(key, `step-${saved.steps + 1}`), id: saved.marker, expected_revision: current.marker.revision, to: step.to, note: step.note, references };
    await saveManifest(manifest);
    await call("state_advance", saved.pending_transition);
    saved.last_transition = saved.pending_transition;
    delete saved.pending_transition;
    saved.steps += 1;
    await saveManifest(manifest);
  }
  return saved;
}

await session();
const manifest = await loadManifest();
if (manifest.origin && manifest.origin !== origin.origin) throw new Error(`manifest belongs to ${manifest.origin}, not ${origin.origin}`);
if (!manifest.origin && command !== "status") { manifest.origin = origin.origin; await saveManifest(manifest); }
const selected = option("--demo", "all");
const targets = selected === "all" ? Object.entries(demos) : [[selected, demos[selected]]];
if (targets.some(([, demo]) => !demo)) throw new Error("--demo must be proposal, release, creative, or all");
const rows = [];
for (const [key, demo] of targets) {
  let saved;
  if (command === "seed") saved = await ensureDemo(manifest, key, demo);
  else if (command === "step") { saved = manifest.demos[key] || await ensureDemo(manifest, key, demo); if (saved.pending_transition) { await call("state_advance", saved.pending_transition); saved.last_transition = saved.pending_transition; delete saved.pending_transition; saved.steps += 1; await saveManifest(manifest); } else saved = await advance(manifest, key, demo); }
  else if (command === "retry") { saved = manifest.demos[key]; if (!saved?.last_transition && !saved?.pending_transition) throw new Error(`no prior transition to retry for ${key}; run step first`); await call("state_advance", saved.pending_transition || saved.last_transition); }
  else if (command === "status") { saved = manifest.demos[key]; if (!saved) throw new Error(`no manifest entry for ${key}; run seed first`); }
  else throw new Error("usage: state-demos.mjs [seed|step|status|retry] [--demo proposal|release|creative|all] [--url http://127.0.0.1:64652]");
  const marker = await call("state_get", { workspace_id: saved.workspace_id, id: saved.marker });
  rows.push({ demo: key, workspace_id: saved.workspace_id, marker_id: saved.marker, state: marker.marker.state, revision: marker.marker.revision, history: marker.history.length, next: (marker.available_transitions || []).map((edge) => edge.to), link: `/w/${saved.workspace_id}/states/${saved.marker}` });
}
console.log(JSON.stringify({ command, demos: rows }, null, 2));
