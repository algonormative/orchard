import "./style.css";
import { canonicalHref, parseHref, type Descriptor, type ResourceRef } from "./resources";

type Json = Record<string, unknown>;
type Workspace = { id: string; name: string; archived?: boolean };
type Store = { id: string; path?: string; name?: string; source?: string };
type ConversationKind = "channel" | "direct" | "broadcast";
type DraftAttachment = { name: string; requestId: string; status: "uploading" | "ready" | "failed"; file?: File; href?: string; ref?: ResourceRef; error?: string };
type Draft = { body: string; attachment?: DraftAttachment };
type PendingMail = { args: Json; draftBody: string; attachmentRequestId?: string; replyRevision: number; state: "sending" | "uncertain" };
type DetailView = "form";
type Screen = "workspace" | "workspaces" | "settings" | "new-workspace" | "home";
type CollectionTab = { kind: "collection"; collection: "tasks" | "agents" | "directs" | "states"; workspaceId: string; href: string; title: string };
type AppTab = Descriptor | CollectionTab;

const rootElement = document.querySelector<HTMLElement>("#app");
if (!rootElement) throw new Error("Orchard could not find its app container.");
const root: HTMLElement = rootElement;

const state: {
  workspaces: Workspace[];
  recentWorkspaceIds: string[];
  workspace?: Workspace;
  snapshot?: Json;
  taskBackend?: Json;
  store?: Store;
  selectedTask?: string;
  selectedConversation?: string;
  conversationKind: ConversationKind;
  conversationMessages: unknown[];
  drafts: Map<string, Draft>;
  pendingMail: Map<string, PendingMail>;
  replyRevision: Map<string, number>;
  onboarding: Map<string, "invite" | "contact" | "dismissed">;
  taskFilter: "all" | "open" | "in_progress" | "blocked" | "closed";
  workspaceRequest: number;
  snapshotRequest: number;
  conversationRequest: number;
  seenMessageIds: Set<string>;
  unread: Map<string, number>;
  senderId?: string;
  replyTo?: string;
  detailView?: DetailView;
  screen: Screen;
  detailEpoch: number;
  taskRequest: number;
  threadScroll?: number;
  composerFocused?: boolean;
  poll?: number;
  socket?: WebSocket;
  reconnect?: number;
  refreshTimer?: number;
  connection: "connecting" | "connected" | "disconnected";
  previewHref?: string;
  tabMenu?: HTMLElement;
  tabs: AppTab[];
  activeHref?: string;
  resourceRequest: number;
  activeResource?: Descriptor;
  resourceData?: Json;
  resourceLinks?: Json;
  agentData?: Json;
  agentLinks?: Json;
  navigationEpoch: number;
  treeExpanded: Set<"chats" | "tasks" | "artifacts" | "states">;
  artifactRoots: Json[];
  artifactEntries: Map<string, Json[]>;
  artifactExpanded: Set<string>;
  stateMarkers: Json[];
  stateMarkersWorkspace?: string;
  stateMarkersLoading?: string;
  stateOpportunities: Json[];
  stateOpportunitiesWorkspace?: string;
  stateOpportunitiesLoading?: string;
  stateCollectionMode: "markers" | "opportunities";
  formReturn?: AppTab;
  newWorkspaceReturn?: Screen;
} = { workspaces: [], recentWorkspaceIds: [], conversationKind: "channel", conversationMessages: [], drafts: new Map(), pendingMail: new Map(), replyRevision: new Map(), onboarding: new Map(), taskFilter: "all", workspaceRequest: 0, snapshotRequest: 0, conversationRequest: 0, seenMessageIds: new Set(), unread: new Map(), screen: "workspace", detailEpoch: 0, taskRequest: 0, tabs: [], resourceRequest: 0, navigationEpoch: 0, connection: "disconnected", treeExpanded: new Set(["chats", "tasks", "artifacts", "states"]), artifactRoots: [], artifactEntries: new Map(), artifactExpanded: new Set(), stateMarkers: [], stateOpportunities: [], stateCollectionMode: "markers" };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const identifier = (value: unknown): string => string(object(value).id) || string(object(value).workspace_id) || string(object(value).channel_id);

let sessionRefresh: Promise<boolean> | undefined;
let tabMenuBackPending = false;
let tabMenuAfterClose: (() => void) | undefined;
let lastResourceClick: { href: string; at: number } | undefined;
let liveGeneration = 0;
const pendingRefreshTopics = new Set<string>();
let refreshFlight: Promise<void> | undefined;
let messagePatchPending = false;
let artifactPatchPending = false;
let taskPatchPending = false;
let statePatchPending = false;
let stateMarkersFlight: Promise<void> | undefined;
let stateMarkersVersion = 0;
let stateMarkersLoadedVersion = -1;
let stateMarkersError = "";
let stateOpportunitiesFlight: Promise<void> | undefined;
let stateOpportunitiesError = "";
let stateOpportunitiesVersion = 0;
let stateOpportunitiesLoadedVersion = -1;

function plugins(): Json[] { return array(state.snapshot?.plugins).map(object); }
function plugin(id: string) { return plugins().find((item) => string(item.id) === id); }
function pluginAttached(id: string, fallback = false) { const item = plugin(id); return item ? item.attached !== false && item.available !== false : fallback; }
function pluginErrors() { return plugins().filter((item) => item.available === false).map((item) => `${string(item.name) || string(item.id) || "plugin"}: ${string(item.health) || "unavailable"}`); }

function hasSelectionWithin(container: HTMLElement) {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && !!selection.anchorNode && container.contains(selection.anchorNode);
}

document.addEventListener("selectionchange", () => {
  if (messagePatchPending) patchMessages();
  if (artifactPatchPending && state.workspace) void refreshVisibleArtifact(state.workspace.id);
  if (taskPatchPending) patchTaskDetailFromCache();
  if (statePatchPending && state.workspace) void refreshStateViews(state.workspace.id);
});
document.addEventListener("focusout", () => {
  window.setTimeout(() => { if (messagePatchPending) patchMessages(); if (artifactPatchPending && state.workspace) void refreshVisibleArtifact(state.workspace.id); if (taskPatchPending) patchTaskDetailFromCache(); if (statePatchPending && state.workspace) void refreshStateViews(state.workspace.id); }, 0);
}, true);

async function ensureBrowserSession(): Promise<boolean> {
  if (sessionRefresh) return sessionRefresh;
  const pending = (async () => {
    const current = await fetch("/api/session", { credentials: "same-origin" });
    const status = object(await current.json().catch(() => ({})));
    if (current.ok && status.authenticated === true) return true;
    const response = await fetch("/api/session", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const session = object(await response.json().catch(() => ({})));
    return response.ok && session.authenticated === true;
  })();
  sessionRefresh = pending;
  try { return await pending; } finally { if (sessionRefresh === pending) sessionRefresh = undefined; }
}

async function call(operation: string, args: Json = {}, allowSessionRefresh = true): Promise<Json> {
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="orchard-csrf"]')?.content;
  const response = await fetch("/api/call", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-Orchard-CSRF": csrf } : {}) },
    body: JSON.stringify({ operation, args }),
  });
  const payload = object(await response.json().catch(() => ({})));
  if (response.status === 401 && allowSessionRefresh && await ensureBrowserSession()) {
    return call(operation, args, false);
  }
  if (response.status === 401) throw new Error("The local browser session could not be refreshed.");
  if (!response.ok) {
    throw new Error(string(payload.error) || `Orchard service returned ${response.status}.`);
  }
  return object(payload.result ?? payload);
}

function notice(message: string, tone: "error" | "info" = "info") {
  const target = document.querySelector<HTMLElement>("#notice");
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function button(label: string, onClick: () => void | Promise<void>, className = "") {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", () => void onClick());
  return node;
}

function actionRow(...items: HTMLElement[]) {
  const row = el("div", "form-actions"); row.append(...items); return row;
}

/** The only renderer for copyable block code.  Keep its source as text, never HTML. */
function copyTextButton(source: () => string, label = "Copy") {
  return button(label, async () => {
    try { await navigator.clipboard.writeText(source()); notice("Copied."); }
    catch { notice("Copying is unavailable in this window.", "error"); }
  }, "copy-button subtle");
}
function codeBlock(content: string, label = "Copy") {
  const block = el("section", "code-block");
  const pre = el("pre", "connection-value");
  const code = el("code");
  code.textContent = content;
  pre.append(code);
  const copy = copyTextButton(() => code.textContent || "", label);
  block.append(pre, copy);
  return block;
}

function channelLabel(value: string) { return `#${value.replace(/^#+/, "")}`; }
function participantLabel(value: string) { return `@${value.replace(/^@+/, "")}`; }
function introductionSummary(value: string) {
  const firstSection = value.split(/(?:\r?\n|\s)##\s+/)[0];
  const plain = firstSection.replace(/^#{1,6}\s*/gm, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 220 ? `${plain.slice(0, 217).trimEnd()}…` : plain;
}

function linkifiedText(value: string) {
  const fragment = document.createDocumentFragment();
  const pattern = /(?:https?:\/\/[^\s<>]+|\/w\/[^\s<>]+)/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index || 0;
    if (start > offset) fragment.append(document.createTextNode(value.slice(offset, start)));
    let candidate = match[0];
    let trailing = "";
    while (/[.,;:!?\])}]/.test(candidate.at(-1) || "")) { trailing = candidate.slice(-1) + trailing; candidate = candidate.slice(0, -1); }
    const orchard = state.workspace ? parseHref(candidate, state.workspace.id) : undefined;
    if (orchard) {
      const link = el("a", "message-link") as HTMLAnchorElement;
      link.href = canonicalHref(orchard); link.textContent = candidate;
      link.addEventListener("click", (event) => { event.preventDefault(); void openResource(descriptor(orchard, string(orchard.path) || string(orchard.id) || orchard.kind)); });
      fragment.append(link);
    } else {
      const external = safeLink(candidate);
      fragment.append(external);
    }
    if (trailing) fragment.append(document.createTextNode(trailing));
    offset = start + match[0].length;
  }
  if (offset < value.length) fragment.append(document.createTextNode(value.slice(offset)));
  return fragment;
}

function messageBody(body: string) {
  const fragment = document.createDocumentFragment();
  const lines = body.split("\n"); let prose: string[] = []; let code: string[] | undefined; let opener = "";
  const flushProse = () => { if (prose.length) { const paragraph = el("p"); paragraph.append(linkifiedText(prose.join("\n"))); fragment.append(paragraph); } prose = []; };
  for (const line of lines) {
    if (!code && /^```(?:[A-Za-z0-9_+.-]+)?[ \t]*$/.test(line)) { flushProse(); opener = line; code = []; continue; }
    if (code && /^```[ \t]*$/.test(line)) { fragment.append(codeBlock(code.join("\n"))); code = undefined; continue; }
    if (code) code.push(line); else prose.push(line);
  }
  if (code) prose.push(opener + (code.length ? `\n${code.join("\n")}` : ""));
  flushProse();
  return fragment;
}

function navigate(screen: Screen, detailView?: DetailView, replace = false, url?: string) {
  state.screen = screen;
  state.detailView = detailView;
  state.detailEpoch += 1;
  state.navigationEpoch += 1;
  const route = { screen, detailView, workspaceId: state.workspace?.id, resourceHref: state.activeHref };
  const method = replace ? "replaceState" : "pushState";
  if (url === undefined) history[method](route, ""); else history[method](route, "", url);
}

function workspaceRootHref(workspaceId: string) {
  return canonicalHref({ kind: "broadcast", workspace_id: workspaceId }).replace(/\/broadcast$/, "");
}

function workspaceSettingsHref(workspaceId: string) { return `${workspaceRootHref(workspaceId)}/settings`; }

function isSettingsLocation(workspaceId: string) {
  return `${window.location.pathname}${window.location.search}` === workspaceSettingsHref(workspaceId) && !window.location.hash;
}

function rememberConversationContext() {
  const thread = document.querySelector<HTMLElement>("#thread");
  state.threadScroll = thread?.scrollTop;
  state.composerFocused = document.activeElement?.getAttribute("aria-label") === "Message";
}
function restoreConversationContext() {
  requestAnimationFrame(() => {
    const thread = document.querySelector<HTMLElement>("#thread");
    if (thread && state.threadScroll !== undefined) thread.scrollTop = state.threadScroll;
    if (state.composerFocused) document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
  });
}

window.addEventListener("popstate", (event) => {
  if (tabMenuBackPending) { tabMenuBackPending = false; const action = tabMenuAfterClose; tabMenuAfterClose = undefined; action?.(); return; }
  if (state.tabMenu) { state.tabMenu.remove(); state.tabMenu = undefined; return; }
  const route = object(event.state);
  const workspaceId = string(route.workspaceId);
  const screen = (string(route.screen) as Screen) || "workspace";
  const detailView = string(route.detailView) as DetailView || undefined;
  const resourceHref = string(route.resourceHref);
  if (screen === "workspaces") {
    state.workspaceRequest += 1; state.navigationEpoch += 1;
    state.screen = screen; state.detailView = undefined; state.detailEpoch += 1;
    renderWorkspaceChooser(true);
    return;
  }
  if (workspaceId && workspaceId !== state.workspace?.id) { void chooseWorkspace(workspaceId, true, false, screen, detailView); return; }
  state.screen = screen;
  state.detailView = detailView;
  state.detailEpoch += 1;
  if (state.screen === "settings") renderSettings(true);
  else if (state.screen === "new-workspace") renderEmptyWorkspace(true);
  else if (state.screen === "home") renderCalmHome(true);
  else if (state.workspace) {
    renderWorkspace();
    if (resourceHref) {
      const local = state.tabs.find((tab) => tab.href === resourceHref);
      if (local) void activateTab(local, true);
      else { const collection = collectionFromHref(resourceHref, state.workspace.id); const ref = parseHref(resourceHref, state.workspace.id); if (collection) void activateTab(collection, true); else if (ref) void openResource(descriptor(ref, "Resource"), true); }
    } else renderEmptyViewer();
  }
  else renderCalmHome(true);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.tabMenu) { event.preventDefault(); closeTabMenu(); return; }
  const editing = event.target instanceof HTMLElement && (event.target.isContentEditable || !!event.target.closest("input, textarea, select, [contenteditable=true]"));
  if (!editing && (event.metaKey || event.ctrlKey) && event.key === "ArrowRight") { event.preventDefault(); cycleTab(1); return; }
  if (!editing && (event.metaKey || event.ctrlKey) && event.key === "ArrowLeft") { event.preventDefault(); cycleTab(-1); return; }
  if (event.key !== "Escape") return;
  if (state.screen === "settings") { openWorkspaceFromSettings(); return; }
  if (state.screen === "workspaces") { leaveWorkspaceChooser(); return; }
  if (state.screen === "new-workspace") { leaveNewWorkspace(); return; }
  if (state.detailView === "form") { const target = state.formReturn; state.formReturn = undefined; state.detailView = undefined; if (target) void activateTab(target, true); else renderEmptyViewer(); return; }
});

function cycleTab(direction: number) {
  if (!state.tabs.length) return; const current = state.tabs.findIndex((tab) => tab.href === state.activeHref);
  const next = state.tabs[(current + direction + state.tabs.length) % state.tabs.length]; void activateTab(next);
}

function isDescriptor(tab: AppTab): tab is Descriptor { return tab.kind !== "collection"; }

function collectionTab(collection: CollectionTab["collection"], workspaceId: string): CollectionTab {
  return { kind: "collection", collection, workspaceId, href: `/w/${encodeURIComponent(workspaceId)}/~${collection}`, title: collection === "tasks" ? "Tasks" : collection === "agents" ? "Agents" : collection === "states" ? "State" : "All direct messages" };
}

function collectionFromHref(href: string, workspaceId: string): CollectionTab | undefined {
  return (["tasks", "agents", "directs", "states"] as const).map((name) => collectionTab(name, workspaceId)).find((tab) => tab.href === href);
}

function prepareTab(tab: AppTab) {
  const existing = state.tabs.find((item) => item.href === tab.href);
  if (existing) return existing;
  if (state.previewHref) {
    const index = state.tabs.findIndex((item) => item.href === state.previewHref);
    if (index >= 0) state.tabs.splice(index, 1);
  }
  state.tabs.push(tab);
  state.previewHref = tab.href;
  return tab;
}

function keepTab(href: string) {
  if (state.previewHref === href) state.previewHref = undefined;
  patchTabs();
}

function observeResourceClick(href: string) {
  const at = Date.now();
  if (lastResourceClick?.href === href && at - lastResourceClick.at < 500) keepTab(href);
  lastResourceClick = { href, at };
}

function canonicalTab(tab: Descriptor): Descriptor {
  if (tab.ref.kind !== "agent") return tab;
  const ref: ResourceRef = { kind: "direct", workspace_id: tab.ref.workspace_id, id: tab.ref.id };
  return descriptor(ref, participantLabel(participantName(tab.ref.id || "")));
}

async function activateTab(tab: AppTab, fromHistory = false) {
  if (isDescriptor(tab)) return openResource(tab, fromHistory);
  prepareTab(tab);
  state.activeHref = tab.href;
  state.activeResource = undefined;
  state.resourceData = undefined;
  state.resourceLinks = undefined;
  state.navigationEpoch += 1;
  patchTabs();
  if (!fromHistory) history.pushState({ screen: "workspace", workspaceId: tab.workspaceId, resourceHref: tab.href }, "", tab.href);
  if (tab.collection === "tasks") renderTaskCollection();
  else if (tab.collection === "agents") renderAgentCollection();
  else if (tab.collection === "states") renderStateCollection();
  else {
    state.selectedConversation = "__all_direct__"; state.conversationKind = "direct"; state.replyTo = undefined; state.conversationMessages = [];
    patchConversations(); patchConversation(); await loadHistory("__all_direct__");
  }
}

function safeLink(value: unknown): HTMLAnchorElement | HTMLSpanElement {
  const label = string(value);
  try {
    const url = new URL(label);
    if (url.protocol === "https:" || url.protocol === "http:") {
      const link = el("a") as HTMLAnchorElement;
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = label;
      return link;
    }
  } catch { /* displayed as plain text below */ }
  return el("span", "reference-text", label);
}

function referenceNode(value: unknown): HTMLElement {
  const reference = object(value);
  const resource = object(reference.resource);
  if (string(reference.type) === "resource" && state.workspace) {
    const ref = resource as ResourceRef;
    if (ref.kind && ref.workspace_id === state.workspace.id) {
      const tab = descriptor(ref, string(reference.label) || string(ref.path) || string(ref.id) || ref.kind);
      const row = el("p", "reference-text"); row.append(button(tab.title, () => void openResource(tab), "subtle")); return row;
    }
    return el("p", "reference-text", "Attached resource is unavailable.");
  }
  const task = object(reference.task_ref);
  const storeId = string(task.store_id) || string(reference.store_id);
  const taskId = string(task.task_id) || string(reference.task_id);
  if (storeId && taskId && state.workspace) {
    const title = `Task ${taskId}`; const row = el("p", "reference-text");
    row.append(button(title, () => void openResource(descriptor({ kind: "task", workspace_id: state.workspace!.id, store_id: storeId, task_id: taskId }, title)), "subtle"));
    return row;
  }
  const commit = string(reference.commit) || string(reference.sha);
  if (commit) return el("p", "reference-text", `Commit ${commit}`);
  const path = string(reference.path) || string(reference.file);
  const rootId = string(reference.root_id);
  if (path && rootId && state.workspace) {
    const row = el("p", "reference-text");
    row.append(button(path, () => void openResource(descriptor({ kind: "file", workspace_id: state.workspace!.id, root_id: rootId, path, revision: string(reference.revision) || undefined }, path)), "subtle"));
    return row;
  }
  if (path) return el("p", "reference-text", `File ${path}`);
  const label = string(reference.label);
  const url = string(reference.url);
  if (url) {
    const node = safeLink(url);
    const row = el("p", "reference-text");
    if (label) row.append(`${label}: `);
    row.append(node);
    return row;
  }
  return el("p", "reference-text", label || "Reference");
}

function shell(title: string, detail: string) {
  root.replaceChildren();
  const panel = el("section", "welcome");
  const noticeBar = el("p", "notice"); noticeBar.id = "notice"; noticeBar.dataset.tone = "info";
  panel.append(el("p", "eyebrow", "ORCHARD"), el("h1", "", title), el("p", "muted", detail), noticeBar);
  root.append(panel);
}

async function refreshWorkspaces() {
  const result = await call("workspace_list");
  state.workspaces = array(result.workspaces ?? result.items ?? result).map((item) => ({
    id: identifier(item), name: string(object(item).name) || identifier(item), archived: object(item).archived === true,
  })).filter((workspace) => workspace.id && !workspace.archived);
  const activeIds = new Set(state.workspaces.map((workspace) => workspace.id));
  state.recentWorkspaceIds = array(result.recent_workspace_ids).map(string).filter((id) => activeIds.has(id));
}

async function initialize() {
  try {
    await refreshWorkspaces();
    if (!state.workspaces.length) {
      navigate("new-workspace", undefined, true);
      return renderEmptyWorkspace(true);
    }
    if (window.location.pathname === "/workspaces") {
      navigate("workspaces", undefined, true, "/workspaces");
      return renderWorkspaceChooser(true);
    }
    const requestedId = workspaceIdFromLocation();
    const requestedWorkspace = requestedId ? state.workspaces.find((workspace) => workspace.id === requestedId) : undefined;
    if (requestedId && !requestedWorkspace) {
      shell("Resource unavailable", "This link belongs to a workspace that is archived, missing, or unavailable to this session.");
      document.querySelector(".welcome")?.append(button("Open available workspace", () => void chooseWorkspace(state.workspaces[0].id, false, true), "primary"));
      return;
    }
    const selectedId = requestedWorkspace?.id || state.workspaces[0].id;
    await chooseWorkspace(selectedId, false, true, isSettingsLocation(selectedId) ? "settings" : "workspace");
  } catch (error) {
    shell("Orchard is unavailable", "The local workspace service did not respond. Check the connection details in Settings, then try again.");
    const retry = button("Try again", () => void initialize());
    document.querySelector(".welcome")?.append(retry, el("p", "error", message(error)));
  }
}

function workspaceIdFromLocation(): string | undefined {
  const match = /^\/w\/([^/]+)(?:\/|$)/.exec(window.location.pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

async function bootstrap() {
  try {
    if (!await ensureBrowserSession()) throw new Error("The local browser session could not be started.");
    await initialize();
  } catch (error) {
    shell("Orchard is unavailable", "The local Orchard server did not respond.");
    document.querySelector(".welcome")?.append(el("p", "error", message(error)));
  }
}

function renderEmptyWorkspace(fromHistory = false) {
  if (!fromHistory) {
    state.newWorkspaceReturn = state.screen;
    navigate("new-workspace");
  }
  const formEpoch = state.detailEpoch;
  shell("Start a workspace", "Create one workspace, then connect the people, channels and task stores that belong in it.");
  const form = el("form", "stack");
  const name = document.createElement("input");
  name.name = "name";
  name.placeholder = "Workspace name";
  name.setAttribute("aria-label", "Workspace name");
  name.autocomplete = "off";
  name.required = true;
  const purpose = document.createElement("textarea");
  purpose.name = "purpose"; purpose.rows = 3; purpose.maxLength = 2000;
  purpose.placeholder = "What is this workspace for? (optional)";
  purpose.setAttribute("aria-label", "Workspace purpose (optional)");
  const submit = button("Create workspace", async () => {
    if (!name.value.trim()) return notice("Give the workspace a name.", "error");
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await call("workspace_create", { name: name.value.trim(), ...(purpose.value.trim() ? { purpose: purpose.value.trim() } : {}) });
      const id = identifier(result.workspace);
      if (!id) throw new Error("The service did not return a workspace id.");
      await refreshWorkspaces();
      if (state.detailEpoch === formEpoch && state.screen === "new-workspace") await chooseWorkspace(id);
    } catch (error) { notice(message(error), "error"); }
    finally { if (document.contains(submit)) submit.disabled = false; }
  }, "primary");
  form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
  const cancel = button("Cancel", () => {
    leaveNewWorkspace();
  }, "subtle");
  form.classList.add("workspace-create-form");
  form.append(name, purpose, actionRow(submit, cancel));
  document.querySelector(".welcome")?.append(form);
}

function leaveNewWorkspace() {
  if (state.newWorkspaceReturn === "workspaces") { state.newWorkspaceReturn = undefined; history.back(); return; }
  state.newWorkspaceReturn = undefined;
  if (state.workspace) { navigate("workspace"); renderWorkspace(); }
  else renderCalmHome();
}

function renderCalmHome(fromHistory = false) {
  if (!fromHistory) navigate("home", undefined, true);
  shell("Orchard", "Create a workspace when you are ready.");
  document.querySelector(".welcome")?.classList.add("welcome-home");
  document.querySelector(".welcome")?.append(button("Create workspace", () => renderEmptyWorkspace(), "primary"));
}

function orderedWorkspaces() {
  const order = new Map(state.recentWorkspaceIds.map((id, index) => [id, index]));
  return [...state.workspaces].sort((left, right) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

function leaveWorkspaceChooser() {
  if (state.workspace && string(object(history.state).workspaceId)) { history.back(); return; }
  if (state.workspace) { void chooseWorkspace(state.workspace.id, false, true); return; }
  const first = orderedWorkspaces()[0];
  if (first) void chooseWorkspace(first.id, false, true);
  else renderCalmHome();
}

function recordWorkspaceVisit(id: string) {
  state.recentWorkspaceIds = [id, ...state.recentWorkspaceIds.filter((workspaceId) => workspaceId !== id)].slice(0, 20);
  void call("workspace_visit", { workspace_id: id }).catch((error) => console.warn("Could not record workspace visit", error));
}

function renderWorkspaceChooser(fromHistory = false) {
  if (!fromHistory) navigate("workspaces", undefined, false, "/workspaces");
  shell("All Workspaces", "Choose a workspace or create a new one.");
  document.querySelector(".welcome")?.classList.add("welcome-home");
  const list = el("div", "stack workspace-list");
  for (const workspace of orderedWorkspaces()) {
    list.append(button(workspace.name, () => void chooseWorkspace(workspace.id), "workspace-choice"));
  }
  const back = button("Back", leaveWorkspaceChooser, "subtle");
  document.querySelector(".welcome")?.append(list, actionRow(button("Create workspace", () => renderEmptyWorkspace(), "primary"), back));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error || "That action could not be completed.");
}

async function chooseWorkspace(id: string, fromHistory = false, replaceHistory = false, targetScreen: Screen = "workspace", targetDetail?: DetailView) {
  const requestedUrl = window.location.href;
  const enteredFromChooser = window.location.pathname === "/workspaces";
  const workspace = state.workspaces.find((item) => item.id === id);
  if (!workspace) return;
  const retainsDrafts = state.workspace?.id === id;
  const retainedConversation = retainsDrafts ? state.selectedConversation : undefined;
  const retainedKind = state.conversationKind;
  const request = ++state.workspaceRequest;
  const snapshot = await call("workspace_snapshot", { workspace_id: id });
  if (request !== state.workspaceRequest) return;
  state.workspace = workspace;
  if (!retainsDrafts) { state.stateMarkers = []; state.stateMarkersWorkspace = undefined; state.stateMarkersLoading = undefined; state.stateOpportunities = []; state.stateOpportunitiesWorkspace = undefined; state.stateOpportunitiesLoading = undefined; state.stateCollectionMode = "markers"; stateMarkersFlight = undefined; stateOpportunitiesFlight = undefined; stateMarkersVersion = 0; stateMarkersLoadedVersion = -1; stateOpportunitiesVersion = 0; stateOpportunitiesLoadedVersion = -1; stateMarkersError = ""; stateOpportunitiesError = ""; }
  stopLiveUpdates();
  state.navigationEpoch += 1;
  state.snapshot = snapshot;
  state.taskBackend = undefined;
  try {
    const settings = await call("settings_get");
    if (request !== state.workspaceRequest) return;
    state.taskBackend = object(object(settings.config).task_backend);
  } catch (error) {
    state.taskBackend = { available: false, error: message(error) };
  }
  state.store = undefined;
  state.selectedTask = undefined;
  state.selectedConversation = retainedConversation;
  state.conversationMessages = [];
  if (!retainsDrafts) {
    state.drafts.clear(); state.tabs = []; state.activeHref = undefined; state.activeResource = undefined; state.resourceData = undefined; state.resourceLinks = undefined;
    state.artifactRoots = []; state.artifactEntries.clear(); state.artifactExpanded.clear();
    state.formReturn = undefined;
  }
  if (!retainsDrafts) {
    state.seenMessageIds = new Set(mailList("history").map((entry) => string(object(entry).id)).filter(Boolean));
    state.unread.clear();
  }
  state.detailView = targetScreen === "workspace" ? targetDetail : undefined;
  state.screen = targetScreen;
  state.senderId = "owner";
  if (targetScreen === "settings") {
    if (!fromHistory) navigate("settings", undefined, replaceHistory, workspaceSettingsHref(id));
    renderSettings(true);
    recordWorkspaceVisit(id);
    return;
  }
  if (targetScreen === "new-workspace") { renderEmptyWorkspace(true); return; }
  if (targetScreen === "home") { renderCalmHome(true); return; }
  renderWorkspace();
  recordWorkspaceVisit(id);
  const requestedCollection = collectionFromHref(new URL(requestedUrl).pathname, id);
  const requested = parseHref(requestedUrl, id);
  if (!fromHistory && !requested && !requestedCollection && !enteredFromChooser) navigate("workspace", undefined, replaceHistory, workspaceRootHref(id));
  if (requestedCollection) { void activateTab(requestedCollection, true); startLiveUpdates(); return; }
  if (requested) { void openResource(descriptor(requested, "Resource"), true); startLiveUpdates(); return; }
  if (state.selectedConversation) {
    await selectConversation(state.conversationKind, state.selectedConversation);
  } else if (mailList("channels").some((item) => identifier(item) === "general")) {
    await selectConversation("channel", "general");
  } else {
    state.conversationKind = retainedKind;
    if (enteredFromChooser) navigate("workspace", undefined, replaceHistory, workspaceRootHref(id));
  }
  startLiveUpdates();
}

function renderWorkspace() {
  if (!state.workspace) return renderEmptyWorkspace();
  root.replaceChildren();
  const layout = el("div", "workspace-layout");
  layout.id = "workspace-layout";
  const top = el("header", "topbar");
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Workspace");
  for (const workspace of state.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.name;
    option.selected = workspace.id === state.workspace.id;
    select.append(option);
  }
  select.addEventListener("change", () => void chooseWorkspace(select.value));
  state.screen = "workspace";
  top.append(el("strong", "brand", "Orchard"), select, button("All workspaces", () => { rememberConversationContext(); renderWorkspaceChooser(); }), button("New workspace", () => { rememberConversationContext(); renderEmptyWorkspace(); }), button("Settings", () => { rememberConversationContext(); renderSettings(); }));
  const noticeBar = el("p", "notice");
  noticeBar.id = "notice";
  noticeBar.dataset.tone = "info";
  const connection = el("span", "connection-status"); connection.id = "connection-status";
  top.append(connection, noticeBar);
  patchConnectionStatus();

  const conversations = el("aside", "sidebar resource-tree");
  conversations.id = "conversations";
  const viewer = el("section", "viewer-shell");
  const tabs = el("nav", "tabstrip"); tabs.id = "tabs"; tabs.setAttribute("aria-label", "Open resources");
  const main = el("section", "conversation");
  main.id = "conversation";
  main.addEventListener("input", () => { if (state.activeHref) keepTab(state.activeHref); });
  main.addEventListener("change", () => { if (state.activeHref) keepTab(state.activeHref); });
  main.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button, a, input[type=file]")) {
      if (state.activeHref) keepTab(state.activeHref);
    }
  }, true);
  viewer.append(tabs, main);
  conversations.addEventListener("click", (event) => { if (event.target instanceof Element && event.target.closest("button") && state.activeHref) observeResourceClick(state.activeHref); });
  layout.append(conversations, viewer);
  root.append(top, layout);
  patchOnboarding();
  patchWorkspace();
  restoreConversationContext();
}

function snapshotList(...keys: string[]) {
  for (const key of keys) {
    const values = array(state.snapshot?.[key]);
    if (values.length) return values;
  }
  return [];
}

function mailSnapshot(): Json { return object(state.snapshot?.mail); }
function mailList(name: string): unknown[] {
  return array(mailSnapshot()[name]);
}
function workspaceStores(): unknown[] { return snapshotList("task_stores"); }
function participantName(id: string): string {
  const item = mailList("participants").map(object).find((participant) => identifier(participant) === id);
  return string(item?.name) || id || "Participant";
}
function taskAssignee(task: Json): string {
  const value = task.assignee ?? task.assignee_id;
  return string(value) || string(object(value).id);
}
function taskMetadata(task: Json) {
  const status = ({ open: "Open", in_progress: "In progress", blocked: "Blocked", closed: "Closed" } as Record<string, string>)[string(task.status)] || string(task.status) || "Unknown";
  const priority = typeof task.priority === "number" ? `P${task.priority}` : "Priority unavailable";
  const assignee = taskAssignee(task);
  return `${status} · ${priority} · ${assignee ? `Assigned to ${participantName(assignee)}` : "Unassigned"}`;
}

function taskRelationSections(data: Json, task: Json, ref: ResourceRef): HTMLElement[] {
  const dependencies: Json[] = []; const dependents: Json[] = [];
  for (const value of array(data.dependencies)) {
    const relation = object(value); const issueId = string(relation.issue_id); const dependsOnId = string(relation.depends_on_id);
    if (issueId && dependsOnId) (issueId === (ref.task_id || string(task.id)) ? dependencies : dependsOnId === (ref.task_id || string(task.id)) ? dependents : dependencies).push(relation);
    else dependencies.push(relation);
  }
  return [["Dependencies", dependencies, "depends_on_id"], ["Dependents", dependents, "issue_id"]].flatMap(([label, values, key]) => {
    const list = values as Json[]; if (!list.length) return [];
    const section = el("section", "task-relations"); section.append(el("h3", "", label as string));
    for (const relation of list) {
      const id = string(relation[key as string]) || string(object(relation.task_ref).task_id) || string(relation.task_id) || string(relation.id);
      if (id && ref.store_id) section.append(button(id, () => void openResource(descriptor({ kind: "task", workspace_id: ref.workspace_id, store_id: ref.store_id, task_id: id }, `Task ${id}`)), "subtle"));
    }
    return [section];
  });
}

function agentContacted(): boolean {
  const agents = mailList("participants").map(object).filter((participant) => !["owner", "orchard"].includes(identifier(participant)));
  return agents.length > 0;
}

function patchOnboarding() {
  const workspace = state.workspace;
  if (!workspace || state.screen !== "workspace") return;
  const id = workspace.id;
  const contact = agentContacted();
  let phase = state.onboarding.get(id);
  if (phase === "dismissed") return;
  if (contact && phase === "invite") { phase = "contact"; state.onboarding.set(id, phase); }
  if (contact && phase !== "contact") return;
  if (!phase) { phase = "invite"; state.onboarding.set(id, phase); }
  const existing = document.querySelector<HTMLElement>(".onboarding-callout");
  if (existing?.dataset.workspaceId === id && existing.dataset.phase === phase) return;
  existing?.remove();
  const callout = el("section", "onboarding-callout");
  callout.dataset.workspaceId = id; callout.dataset.phase = phase;
  const close = button("Dismiss", () => { state.onboarding.set(id, "dismissed"); callout.remove(); }, "subtle");
  if (phase === "contact") {
    callout.setAttribute("role", "status");
    callout.append(el("h2", "", "Agent registered"), el("p", "onboarding-feedback", "An agent is registered in this workspace. Its last contact and messages show what it actually did."), close);
    window.setTimeout(() => { if (state.workspace?.id === id && state.onboarding.get(id) === "contact") { state.onboarding.set(id, "dismissed"); callout.remove(); } }, 12_000);
  } else {
    callout.append(el("h2", "", "Invite an agent into this workspace"), el("p", "onboarding-feedback", "Share the generic joining prompt with an agent you already use. Registration and last contact appear here after it connects."));
    let joiningPrompt = "";
    const copy = copyTextButton(() => joiningPrompt, "Copy joining prompt"); copy.disabled = true;
    const actions = el("div", "onboarding-actions");
    actions.append(copy, button("Connection settings", showAgentForm, "subtle"), close);
    callout.append(actions);
    void call("workspace_intro", { workspace_id: id }).then((result) => {
      if (state.workspace?.id !== id || !document.contains(copy)) return;
      joiningPrompt = string(result.joining_prompt); copy.disabled = !joiningPrompt;
    }).catch((error) => { if (document.contains(copy)) notice(message(error), "error"); });
  }
  root.insertBefore(callout, document.querySelector("#workspace-layout"));
}

function patchWorkspace() {
  patchConversations();
  patchTabs();
  const active = state.tabs.find((tab) => tab.href === state.activeHref);
  if (active) void activateTab(active, true);
  else renderEmptyViewer();
}

function patchConversations() {
  const panel = document.querySelector<HTMLElement>("#conversations");
  if (!panel || !state.workspace) return;
  panel.replaceChildren();
  const errors = [...snapshotErrors(), ...taskBackendErrors(), ...pluginErrors()];
  if (errors.length) panel.append(el("p", "error", `Unavailable source${errors.length === 1 ? "" : "s"}: ${errors.join("; ")}`));

  const section = (name: "chats" | "tasks" | "artifacts" | "states", label: string) => {
    const details = document.createElement("details");
    details.className = "tree-group";
    details.open = state.treeExpanded.has(name);
    details.addEventListener("toggle", () => {
      if (details.open) state.treeExpanded.add(name); else state.treeExpanded.delete(name);
      if (name === "artifacts" && details.open && !state.artifactRoots.length) void loadArtifactRoots();
    });
    details.append(el("summary", "tree-heading", label));
    panel.append(details);
    return details;
  };

  const chats = section("chats", "Chats");
  const conversationActive = (kind: ConversationKind, id: string) => {
    if (!state.workspace) return false;
    if (kind === "direct" && id === "__all_direct__") return state.activeHref === collectionTab("directs", state.workspace.id).href;
    const ref: ResourceRef = kind === "broadcast" ? { kind, workspace_id: state.workspace.id } : { kind, workspace_id: state.workspace.id, id };
    return state.activeHref === canonicalHref(ref);
  };
  const channels = mailList("channels").filter((channel) => !isSystemChannel(channel));
  if (!channels.length) chats.append(el("p", "muted", "No channels yet."));
  for (const channel of channels) {
    const item = object(channel);
    const id = identifier(item);
    const label = withUnread(channelLabel(string(item.name) || string(item.title) || id), `channel:${id}`);
    chats.append(button(label, async () => {
      await selectConversation("channel", id);
    }, conversationActive("channel", id) ? "selected conversation-button" : "conversation-button"));
  }
  chats.append(button("New channel", showChannelForm, "tree-action subtle"));
  const people = mailList("participants").map(object).filter((person) => identifier(person) !== "owner" && identifier(person) !== "orchard");
  if (people.length) chats.append(el("p", "tree-label", "Direct"));
  for (const person of people) { const id = identifier(person); chats.append(button(withUnread(participantLabel(string(person.name) || id), `direct:${id}`), () => selectConversation("direct", id), conversationActive("direct", id) ? "selected conversation-button" : "conversation-button")); }
  if (people.length) chats.append(button(withUnread("All direct messages", "direct:__all_direct__"), () => selectConversation("direct", "__all_direct__"), conversationActive("direct", "__all_direct__") ? "selected conversation-button" : "conversation-button"));
  chats.append(button(withUnread("Broadcast", "broadcast:broadcast"), () => selectConversation("broadcast", "broadcast"), conversationActive("broadcast", "broadcast") ? "selected conversation-button" : "conversation-button"));
  chats.append(button("Agents", () => void activateTab(collectionTab("agents", state.workspace!.id)), "tree-action subtle"), button("Connection settings", showAgentForm, "tree-action subtle"));

  const tasks = section("tasks", "Tasks");
  if (!pluginAttached("tasks", true)) tasks.remove();
  else {
  tasks.append(button("All tasks", openTasks, "tree-action subtle"), button("Add project", () => void attachRepository(), "tree-action subtle"));
  for (const value of workspaceStores()) {
    const item = object(value); const store = object(item.store); const storeId = identifier(store) || string(store.store_id);
    const storeName = string(store.name) || basename(string(store.path)) || storeId;
    const group = el("div", "tree-subgroup"); group.append(button(storeName, () => { selectStore(item); void activateTab(collectionTab("tasks", state.workspace!.id)); }, "store-button subtle"));
    for (const value of array(item.tasks)) {
      const task = object(value); const taskId = string(task.task_id) || identifier(task);
      if (taskId) group.append(button(string(task.title) || taskId, () => void openResource(descriptor({ kind: "task", workspace_id: state.workspace!.id, store_id: storeId, task_id: taskId }, string(task.title) || taskId)), "conversation-button task-tree-item"));
    }
    tasks.append(group);
  }
  }

  const artifacts = section("artifacts", "Artifacts");
  artifacts.id = "artifact-tree";
  renderArtifactTree(artifacts);
  if (artifacts.open && !state.artifactRoots.length) void loadArtifactRoots();

  if (pluginAttached("state")) {
    const states = section("states", "State");
    states.append(button("All state markers", () => void activateTab(collectionTab("states", state.workspace!.id)), "tree-action subtle"));
    if (stateMarkersError) states.append(el("p", "error", `State is unavailable: ${stateMarkersError}`));
    if (!stateMarkersError && !state.stateMarkers.length) states.append(el("p", "muted", state.stateMarkersWorkspace === state.workspace.id ? "No state markers yet." : "Loading state markers…"));
    for (const marker of state.stateMarkers) {
      const id = identifier(marker); const title = string(marker.title) || id;
      states.append(button(`${title} · ${string(marker.state) || "unknown"}`, () => void openResource(descriptor({ kind: "state", workspace_id: state.workspace!.id, id }, title)), "conversation-button"));
    }
    if (states.open && state.stateMarkersWorkspace !== state.workspace.id) void loadStateMarkers();
  }
}

async function loadStateMarkers(force = false) {
  if (!state.workspace) return;
  if (force) { stateMarkersVersion += 1; state.stateMarkersWorkspace = undefined; }
  if (state.stateMarkersWorkspace === state.workspace.id && stateMarkersLoadedVersion >= stateMarkersVersion) return;
  if (stateMarkersFlight) { await stateMarkersFlight; return loadStateMarkers(false); }
  const workspaceId = state.workspace.id;
  const version = stateMarkersVersion;
  state.stateMarkersLoading = workspaceId;
  const flight = (async () => { try {
    const result = await call("state_list", { workspace_id: workspaceId });
    if (state.workspace?.id === workspaceId && version === stateMarkersVersion) { state.stateMarkers = array(result.markers).map(object); state.stateMarkersWorkspace = workspaceId; stateMarkersLoadedVersion = version; stateMarkersError = ""; patchConversations(); if (state.activeHref === collectionTab("states", workspaceId).href) renderStateCollectionRetained(); }
  } catch (error) { if (state.workspace?.id === workspaceId && version === stateMarkersVersion) { state.stateMarkersWorkspace = workspaceId; stateMarkersLoadedVersion = version; stateMarkersError = message(error); patchConversations(); if (state.activeHref === collectionTab("states", workspaceId).href) renderStateCollectionRetained(); } }
  finally { if (state.stateMarkersLoading === workspaceId) state.stateMarkersLoading = undefined; } })();
  stateMarkersFlight = flight;
  try { await flight; } finally { if (stateMarkersFlight === flight) stateMarkersFlight = undefined; }
  if (stateMarkersLoadedVersion < stateMarkersVersion) return loadStateMarkers(false);
}

async function loadStateOpportunities(force = false) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.id;
  if (force) { stateOpportunitiesVersion += 1; state.stateOpportunitiesWorkspace = undefined; }
  if (state.stateOpportunitiesWorkspace === workspaceId && stateOpportunitiesLoadedVersion >= stateOpportunitiesVersion) return;
  if (stateOpportunitiesFlight) { await stateOpportunitiesFlight; return loadStateOpportunities(false); }
  const version = stateOpportunitiesVersion;
  state.stateOpportunitiesLoading = workspaceId;
  const flight = (async () => {
    try {
      const result = await call("state_opportunities", { workspace_id: workspaceId });
      if (state.workspace?.id === workspaceId && version === stateOpportunitiesVersion) { state.stateOpportunities = array(result.opportunities).map(object); state.stateOpportunitiesWorkspace = workspaceId; stateOpportunitiesLoadedVersion = version; stateOpportunitiesError = ""; if (state.activeHref === collectionTab("states", workspaceId).href && state.stateCollectionMode === "opportunities") renderStateCollectionRetained(); }
    } catch (error) {
      if (state.workspace?.id === workspaceId && version === stateOpportunitiesVersion) { state.stateOpportunities = []; state.stateOpportunitiesWorkspace = workspaceId; stateOpportunitiesLoadedVersion = version; stateOpportunitiesError = message(error); if (state.activeHref === collectionTab("states", workspaceId).href && state.stateCollectionMode === "opportunities") renderStateCollectionRetained(); }
    } finally { if (state.stateOpportunitiesLoading === workspaceId) state.stateOpportunitiesLoading = undefined; }
  })();
  stateOpportunitiesFlight = flight;
  try { await flight; } finally { if (stateOpportunitiesFlight === flight) stateOpportunitiesFlight = undefined; }
  if (stateOpportunitiesLoadedVersion < stateOpportunitiesVersion) return loadStateOpportunities(false);
}

function patchTabs() {
  const tabstrip = document.querySelector<HTMLElement>("#tabs"); if (!tabstrip) return;
  tabstrip.replaceChildren();
  for (const tab of state.tabs) {
    const tabButton = button(tab.title, () => void activateTab(tab), tab.href === state.activeHref ? "selected resource-tab" : "resource-tab");
    tabButton.setAttribute("role", "tab"); tabButton.setAttribute("aria-selected", String(tab.href === state.activeHref));
    tabButton.addEventListener("click", () => observeResourceClick(tab.href));
    tabButton.addEventListener("dblclick", () => keepTab(tab.href));
    tabButton.addEventListener("contextmenu", (event) => { event.preventDefault(); openTabMenu(tab.href, event.clientX, event.clientY); });
    const close = button("×", () => closeTab(tab.href), "tab-close subtle"); close.setAttribute("aria-label", `Close ${tab.title}`);
    const menu = button("⋯", () => { const bounds = menu.getBoundingClientRect(); openTabMenu(tab.href, bounds.left, bounds.bottom); }, "tab-menu-trigger subtle");
    menu.setAttribute("aria-label", `Tab options for ${tab.title}`);
    const item = el("span", "tab-item"); item.dataset.preview = String(state.previewHref === tab.href);
    item.draggable = true;
    item.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("text/plain", tab.href); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; });
    item.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; });
    item.addEventListener("drop", (event) => { event.preventDefault(); const source = event.dataTransfer?.getData("text/plain"); if (source) moveTabTo(source, tab.href); });
    item.append(tabButton, menu, close); tabstrip.append(item);
  }
}

function moveTabTo(source: string, target: string) {
  const from = state.tabs.findIndex((tab) => tab.href === source);
  const to = state.tabs.findIndex((tab) => tab.href === target);
  if (from < 0 || to < 0 || from === to) return;
  const [moving] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, moving);
  patchTabs();
}

function closeTabMenu(afterClose?: () => void) {
  state.tabMenu?.remove(); state.tabMenu = undefined;
  if (object(history.state).tabMenu === true) { tabMenuBackPending = true; tabMenuAfterClose = afterClose; history.back(); }
  else afterClose?.();
}

function openTabMenu(href: string, x: number, y: number) {
  const tab = state.tabs.find((item) => item.href === href); if (!tab) return;
  if (!state.tabMenu) history.pushState({ ...object(history.state), tabMenu: true }, "", window.location.href);
  state.tabMenu?.remove();
  const menu = el("div", "tab-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", `Options for ${tab.title}`);
  menu.style.position = "fixed"; menu.style.left = `${Math.min(x, innerWidth - 220)}px`; menu.style.top = `${Math.min(y, innerHeight - 260)}px`; menu.style.zIndex = "20";
  const action = (label: string, effect: () => void, disabled = false) => { const control = button(label, () => closeTabMenu(effect), "subtle"); control.setAttribute("role", "menuitem"); control.disabled = disabled; menu.append(control); };
  const index = state.tabs.findIndex((item) => item.href === href);
  action("Keep Open", () => keepTab(href), state.previewHref !== href);
  action("Move Left", () => moveTabTo(href, state.tabs[index - 1]?.href || href), index === 0);
  action("Move Right", () => moveTabTo(href, state.tabs[index + 1]?.href || href), index === state.tabs.length - 1);
  action("Close", () => closeTab(href));
  action("Close Others", () => closeTabGroup((item) => item.href !== href));
  action("Close Tabs to Right", () => closeTabGroup((_item, position) => position > index), index === state.tabs.length - 1);
  action("Close All", () => closeTabGroup(() => true));
  document.body.append(menu); state.tabMenu = menu;
  window.setTimeout(() => { const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) { document.removeEventListener("pointerdown", outside); if (state.tabMenu === menu) closeTabMenu(); } }; document.addEventListener("pointerdown", outside); }, 0);
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function closeTabGroup(predicate: (tab: AppTab, index: number) => boolean) {
  const active = state.activeHref;
  state.tabs = state.tabs.filter((tab, index) => !predicate(tab, index));
  if (state.previewHref && !state.tabs.some((tab) => tab.href === state.previewHref)) state.previewHref = undefined;
  state.resourceRequest += 1; state.navigationEpoch += 1;
  const next = state.tabs.find((tab) => tab.href === active) || state.tabs.at(-1);
  if (next?.href === active) patchTabs();
  else if (next) void activateTab(next);
  else { patchTabs(); if (state.workspace) navigate("workspace", undefined, false, workspaceRootHref(state.workspace.id)); renderEmptyViewer(); }
}

function descriptor(ref: ResourceRef, title: string): Descriptor { return { ref, href: canonicalHref(ref), title, kind: ref.kind }; }
async function openResource(tab: Descriptor, fromHistory = false) {
  tab = canonicalTab(tab);
  const existing = prepareTab(tab);
  state.activeHref = tab.href; state.activeResource = existing && isDescriptor(existing) ? existing : tab; state.navigationEpoch += 1; patchTabs();
  if (!fromHistory) history.pushState({ screen: "workspace", workspaceId: tab.ref.workspace_id, resourceHref: tab.href }, "", tab.href);
  if (tab.href === `/w/${encodeURIComponent(tab.ref.workspace_id)}/tasks`) { renderTaskCollection(); return; }
  if (tab.ref.kind === "channel") return selectConversation("channel", tab.ref.id || "", true);
  if (tab.ref.kind === "direct") return selectConversation("direct", tab.ref.id || "", true);
  if (tab.ref.kind === "broadcast") return selectConversation("broadcast", "broadcast", true);
  const workspaceId = state.workspace?.id; const request = ++state.resourceRequest;
  if (!workspaceId) return;
  try {
    const result = await call("resource_get", { workspace_id: workspaceId, ref: tab.ref });
    if (request !== state.resourceRequest || state.workspace?.id !== workspaceId || state.activeHref !== tab.href) return;
    state.resourceData = object(result.resource); state.resourceLinks = object(result.links);
    const title = string(state.resourceData.title);
    const openTab = state.tabs.find((item) => item.href === tab.href);
    if (title && openTab) openTab.title = title;
    if (title && state.activeResource?.href === tab.href) state.activeResource.title = title;
    patchTabs(); renderResourceDetail(state.resourceData, state.resourceLinks);
  } catch (error) { if (request === state.resourceRequest && state.workspace?.id === workspaceId && state.activeHref === tab.href) renderResourceError(tab.title, message(error)); }
}
function closeTab(href: string) {
  const index = state.tabs.findIndex((tab) => tab.href === href); if (index < 0) return;
  const previousActive = state.activeHref; const wasActive = previousActive === href;
  state.tabs.splice(index, 1); const next = state.tabs[index] || state.tabs[index - 1];
  if (state.previewHref === href) state.previewHref = undefined;
  if (!wasActive) { state.activeHref = previousActive; patchTabs(); return; }
  state.activeHref = next?.href;
  state.resourceRequest += 1; state.navigationEpoch += 1;
  patchTabs();
  if (next) void activateTab(next);
  else {
    if (state.workspace) navigate("workspace", undefined, false, workspaceRootHref(state.workspace.id));
    renderEmptyViewer();
  }
}
function renderEmptyViewer() { state.activeHref = undefined; state.activeResource = undefined; state.resourceData = undefined; state.resourceLinks = undefined; const panel = document.querySelector<HTMLElement>("#conversation"); if (panel) panel.replaceChildren(el("header", "conversation-title", "Choose a resource"), el("p", "empty-state muted", "Select a chat, task, or artifact from the tree.")); }
function renderResourceError(title: string, error: string) { const panel = document.querySelector<HTMLElement>("#conversation"); if (panel) panel.replaceChildren(el("header", "conversation-title", title), el("p", "error", error)); }
function renderResourceDetail(resource: Json, links: Json) {
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel) return;
  panel.replaceChildren(el("header", "conversation-title", string(resource.title) || "Resource"));
  const data = object(resource.data); const content = string(data.text);
  const mime = string(data.mime_type).toLowerCase(); const download = string(data.download_url); const preview = string(data.preview_url);
  if (state.activeResource?.ref.kind === "message") {
    const record = object(data.message); const senderId = string(record.sender_id); const destination = object(record.destination); const meta = el("div", "message-meta resource-message-meta");
    if (senderId && state.workspace) meta.append(button(participantLabel(participantName(senderId)), () => void openResource(descriptor({ kind: "agent", workspace_id: state.workspace!.id, id: senderId }, participantLabel(participantName(senderId)))), "subtle message-sender"));
    const sentAt = string(record.sent_at) || string(record.created_at) || string(record.timestamp); if (sentAt) meta.append(el("time", "message-time", sentAt));
    panel.append(meta);
    const destinationKind = string(destination.kind); const destinationId = string(destination.id);
    if (state.workspace && destinationKind) {
      const conversationRef: ResourceRef | undefined = destinationKind === "channel" && destinationId ? { kind: "channel", workspace_id: state.workspace.id, id: destinationId } : destinationKind === "broadcast" ? { kind: "broadcast", workspace_id: state.workspace.id } : destinationKind === "direct" ? { kind: "direct", workspace_id: state.workspace.id, id: destinationId === "owner" ? senderId : destinationId } : undefined;
      if (conversationRef) panel.append(button(destinationKind === "channel" ? channelLabel(destinationId) : destinationKind === "broadcast" ? "Broadcast" : participantLabel(participantName(conversationRef.id || "")), () => void openResource(descriptor(conversationRef, destinationKind)), "subtle destination-link"));
    }
    panel.append(messageBody(string(record.body) || string(record.content) || string(data.body) || content)); for (const ref of array(record.refs ?? data.refs)) panel.append(referenceNode(ref));
  } else if (state.activeResource?.ref.kind === "agent") {
    const participant = object(data.participant); panel.append(el("p", "muted", string(participant.name) || string(participant.id) || "Agent")); if (string(participant.last_contact_at)) panel.append(el("p", "muted", `Last contact ${string(participant.last_contact_at)}`)); else panel.append(el("p", "muted", "Registered; no recorded contact yet."));
  } else if (state.activeResource?.ref.kind === "state") {
    const marker = object(data.marker ?? data); const definition = object(data.definition);
    const subject = object(marker.subject); const attached = data.attached !== false && pluginAttached("state");
    panel.append(el("p", "task-metadata", `State: ${string(marker.state) || "unknown"} · revision ${marker.revision === undefined ? "0" : String(marker.revision)}`));
    if (string(subject.kind) && subject.workspace_id === state.workspace?.id) { const subjectActions = el("div", "resource-actions"); subjectActions.append(button(`Subject: ${string(subject.path) || string(subject.title) || string(subject.id) || string(subject.task_id) || string(subject.kind)}`, () => void openResource(descriptor(subject as ResourceRef, string(subject.path) || string(subject.id) || string(subject.kind))), "subtle")); panel.append(subjectActions); }
    const guidance = object(data.guidance);
    if (string(guidance.instructions) || array(guidance.capabilities).length) {
      const section = el("section", "state-guidance"); section.append(el("h3", "", "Guidance"));
      if (string(guidance.instructions)) section.append(el("p", "", string(guidance.instructions)));
      const capabilities = array(guidance.capabilities).map(string).filter(Boolean);
      if (capabilities.length) section.append(el("p", "muted", `Relevant capabilities: ${capabilities.join(", ")}`));
      panel.append(section);
    }
    const observedTask = object(data.task);
    if (Object.keys(observedTask).length) {
      const taskRef = subject.kind === "task" && subject.workspace_id === state.workspace?.id ? subject as ResourceRef : undefined;
      const section = el("section", "state-observed-task"); section.append(el("h3", "", "Observed task"));
      const title = string(observedTask.title) || string(observedTask.id) || string(taskRef?.task_id) || "Task";
      if (taskRef?.store_id && taskRef.task_id) section.append(button(title, () => void openResource(descriptor(taskRef, title)), "subtle")); else section.append(el("p", "", title));
      section.append(el("p", "muted", taskMetadata(observedTask)));
      panel.append(section);
    }
    const definitionVersion = definition.version ?? marker.definition_version;
    panel.append(el("p", "muted", `Definition ${string(definition.label) || string(marker.definition_id) || "unknown"} · v${definitionVersion === undefined || definitionVersion === null ? "?" : String(definitionVersion)}`));
    panel.append(el("p", "muted", `Actor: ${string(marker.created_by) || "unknown"}`));
    const history = array(data.history); const historySection = el("section", "state-history"); historySection.append(el("h3", "", "History"));
    if (!history.length) historySection.append(el("p", "muted", "No recorded transitions."));
    for (const entry of history) {
      const item = object(entry); const actor = string(item.actor) || string(item.participant_id); const note = string(item.note); const timestamp = typeof item.timestamp === "number" ? new Date(item.timestamp * 1000).toLocaleString() : string(item.at) || string(item.created_at);
      const row = el("p", "muted", `${string(item.from) || "—"} → ${string(item.to) || string(item.state) || "—"}${actor ? ` · ${actor}` : ""}${note ? ` · ${note}` : ""}${timestamp ? ` · ${timestamp}` : ""}${item.revision !== undefined ? ` · r${String(item.revision)}` : ""}`);
      for (const reference of array(item.references)) { const ref = object(reference) as ResourceRef; if (ref.kind && ref.workspace_id === state.workspace?.id) row.append(document.createTextNode(" "), button(string(ref.path) || string(ref.id) || string(ref.task_id) || ref.kind, () => void openResource(descriptor(ref, string(ref.path) || string(ref.id) || string(ref.task_id) || ref.kind)), "subtle")); }
      historySection.append(row);
    }
    panel.append(historySection);
    const transitions = array(data.available_transitions).map(object);
    if (!attached) panel.append(el("p", "muted", "State is detached. Preserved marker data is read-only."));
    else if (transitions.length) {
      const controls = el("section", "state-transitions"); controls.append(el("h3", "", "Allowed transitions"));
      for (const transition of transitions) {
        const to = string(transition.to); if (!to) continue;
        const readiness = string(transition.readiness) || "ready";
        const row = el("div", `state-transition state-transition-${readiness}`);
        row.append(el("p", "", `${string(transition.label) || `${string(transition.from) || "current"} → ${to}`} · ${readiness === "ready" ? "Ready" : readiness === "needs_input" ? "Needs input" : "Blocked"}`));
        if (string(transition.instructions)) row.append(el("p", "muted", string(transition.instructions)));
        const prerequisites = array(transition.prerequisites).map(object).map((prerequisite) => {
          const kind = string(prerequisite.kind); if (kind === "subject_task_closed") return "Subject task closed";
          const resourceKind = string(prerequisite.resource_kind); if (resourceKind === "file") return "File reference required"; if (resourceKind === "message") return "Message reference required"; if (resourceKind === "task") return "Task reference required"; return string(prerequisite.label) || kind || resourceKind;
        }).filter(Boolean); if (prerequisites.length) row.append(el("p", "muted", `Prerequisites: ${prerequisites.join(", ")}`));
        const reasons = array(transition.reasons).map(string).filter(Boolean); if (reasons.length) row.append(el("p", "state-transition-reasons", reasons.join(" · ")));
        controls.append(row);
      }
      panel.append(controls);
    }
  } else if (state.activeResource?.ref.kind === "task") {
    const task = object(data.task); const activeTaskRef = state.activeResource.ref;
    panel.append(el("p", "task-context muted", [string(task.id) || activeTaskRef.task_id, activeTaskRef.store_id].filter(Boolean).join(" · ")));
    panel.append(el("p", "task-metadata", taskMetadata(task)));
    panel.append(el("p", "task-description", string(task.description) || string(data.description) || content || "No task description."));
    panel.append(...taskRelationSections(data, task, activeTaskRef));
    const ref = state.activeResource.ref; if (ref.store_id && ref.task_id && state.workspace) {
      const status = document.createElement("select"); status.setAttribute("aria-label", "Task status"); for (const value of ["open", "in_progress", "blocked", "closed"]) { const option = document.createElement("option"); option.value = value; option.textContent = value; option.selected = value === string(task.status) || value === string(data.status); status.append(option); }
      status.addEventListener("change", () => { status.dataset.dirty = "true"; });
      const active = state.activeResource; const workspaceId = state.workspace.id; const href = active.href; const epoch = state.navigationEpoch;
      const tasksAttached = pluginAttached("tasks", true); status.disabled = !tasksAttached;
      const update = button("Update status", async () => { try { await call("task_update", { workspace_id: workspaceId, store_id: ref.store_id, task_id: ref.task_id, status: status.value, request_id: crypto.randomUUID() }); if (state.workspace?.id === workspaceId && state.activeHref === href && state.navigationEpoch === epoch) void openResource(active, true); } catch (error) { notice(message(error), "error"); } }, "subtle"); update.disabled = !tasksAttached;
      const controls = el("div", "task-controls"); controls.append(status, update);
      if (tasksAttached && !taskAssignee(task) && string(task.status) === "open") {
        const claim = button("Claim task", async () => {
        if (claim.disabled) return; claim.disabled = true;
        try {
          await call("task_claim", { workspace_id: workspaceId, store_id: ref.store_id, task_id: ref.task_id, participant_id: "owner", request_id: crypto.randomUUID() });
          notice(`Task claimed by ${participantName("owner")}.`);
          if (state.workspace?.id === workspaceId) { if (state.store?.id === ref.store_id) await loadTasks(); if (state.activeHref === href && state.navigationEpoch === epoch) void openResource(active, true); }
        } catch (error) { notice(message(error), "error"); }
        finally { if (document.contains(claim)) claim.disabled = false; }
      }, "subtle task-claim"); controls.append(claim);
      }
      panel.append(controls);
    }
  } else if (state.activeResource?.ref.kind === "file") {
    if (typeof data.text === "string") {
      if (content) panel.append(mime.includes("markdown") || /\.(md|markdown)$/i.test(string(resource.title)) ? markdownBody(content, state.activeResource.ref) : codeBlock(content));
      else panel.append(el("p", "empty-state muted", "This file is empty."));
    } else if (data.binary === true) {
      panel.append(el("p", "muted", `${Number(data.byte_length) || 0} bytes`));
      if (preview && /^image\/(?:png|jpe?g|gif|webp)$/i.test(mime)) { const image = document.createElement("img"); image.src = preview; image.alt = string(resource.title) || "Artifact image"; image.className = "artifact-image"; panel.append(image); }
      else panel.append(el("p", "muted", "This file does not have an inline preview."));
    } else panel.append(el("p", "muted", Number(data.byte_length) > 128 * 1024 ? "This text file is too large to preview here." : "This file does not have an inline preview."));
    if (download) { const link = el("a", "download-link", "Download") as HTMLAnchorElement; link.href = download; link.download = ""; panel.append(link); }
  }
  else if (state.activeResource?.ref.kind === "url") { const value = state.activeResource.ref.url || ""; panel.append(el("p", "muted", value)); const link = safeLink(value); if (link instanceof HTMLAnchorElement) { link.textContent = "Open link"; panel.append(link); } }
  else panel.append(el("p", "muted", "No readable detail is available for this resource."));
  const active = state.activeResource;
  if (active) appendResourceActions(panel, active, links);
  if (active?.ref.kind === "file") void renderFileHistory(panel, active);
}

function appendResourceActions(panel: HTMLElement, active: Descriptor, links: Json) {
  const actions = el("div", "resource-actions");
  actions.append(button("Copy link", async () => { try { await navigator.clipboard.writeText(new URL(active.href, window.location.origin).href); notice("Copied."); } catch { notice("Copying is unavailable in this window.", "error"); } }, "subtle"));
  actions.append(button("Add link", () => showLinkForm(active), "subtle"));
  panel.append(actions);
  const outgoing = array(links.outgoing); const incoming = array(links.incoming);
  if (!outgoing.length && !incoming.length) return;
  const related = el("section", "related-links"); related.append(el("h3", "", "Related"));
  const appendLinks = (label: string, values: unknown[], key: "source" | "target") => { if (!values.length) return; related.append(el("h4", "", label)); for (const value of values) { const item = object(value); const ref = object(item[key]) as ResourceRef; const title = string(item.label) || string(ref.path) || string(ref.id) || string(ref.task_id) || string(ref.url) || ref.kind || "Resource"; if (ref.kind && ref.workspace_id === state.workspace?.id) related.append(button(title, () => void openResource(descriptor(ref, title)), "subtle")); else related.append(el("p", "muted", title)); } };
  appendLinks("Links", outgoing, "target"); appendLinks("Backlinks", incoming, "source");
  panel.append(related);
}

function showLinkForm(source: Descriptor) {
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel || !state.workspace) return;
  const form = el("form", "inline-form"); const input = document.createElement("input"); input.placeholder = "Paste an Orchard link or https:// URL"; input.setAttribute("aria-label", "Link resource");
  const workspaceId = state.workspace.id; const href = source.href; const epoch = state.navigationEpoch;
  const submit = button("Add link", async () => { const target = attachmentRef(input.value.trim()); if (!target) return; try { await call("resource_link", { workspace_id: workspaceId, source: source.ref, target, request_id: crypto.randomUUID() }); if (state.workspace?.id === workspaceId && state.activeHref === href && state.navigationEpoch === epoch) void openResource(source, true); } catch (error) { notice(message(error), "error"); } }, "primary");
  form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); }); form.append(input, submit, button("Cancel", () => form.remove(), "subtle")); panel.append(form); input.focus();
}

async function renderFileHistory(panel: HTMLElement, tab: Descriptor) {
  if (!state.workspace || !tab.ref.root_id) return; const workspaceId = state.workspace.id; const request = state.resourceRequest;
  try { const result = await call("artifact_history", { workspace_id: workspaceId, root_id: tab.ref.root_id, path: tab.ref.path || "" }); if (request !== state.resourceRequest || state.workspace?.id !== workspaceId || state.activeHref !== tab.href || !panel.isConnected) return; const versions = array(result.versions); if (!versions.length) return; const section = document.createElement("details"); section.className = "file-history"; section.append(el("summary", "", tab.ref.revision ? `Versions · pinned ${tab.ref.revision.slice(0, 10)}` : "Versions")); const current = button("Working copy", () => void openResource(descriptor({ ...tab.ref, revision: undefined }, tab.title)), tab.ref.revision ? "subtle" : "selected subtle"); section.append(current); for (const value of versions) { const version = object(value); const revision = string(version.revision); if (!revision) continue; section.append(button(`${revision.slice(0, 10)} ${string(version.summary)}`, () => void openResource(descriptor({ ...tab.ref, revision }, tab.title), false), tab.ref.revision === revision ? "selected subtle" : "subtle")); } panel.append(section); } catch (error) { notice(message(error), "error"); }
}

function markdownBody(source: string, file?: ResourceRef) {
  const section = el("article", "markdown-body"); let code: string[] | undefined;
  const flushCode = () => { if (code) { section.append(codeBlock(code.join("\n"))); code = undefined; } };
  for (const line of source.split("\n")) {
    if (/^```[^`]*$/.test(line)) { if (code) flushCode(); else code = []; continue; }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { const node = el(`h${heading[1].length}` as "h1" | "h2" | "h3"); appendMarkdownInline(node, heading[2], file); section.append(node); continue; }
    const list = /^[-*]\s+(.+)$/.exec(line);
    if (list) { let ul = section.lastElementChild; if (!(ul instanceof HTMLUListElement)) { ul = document.createElement("ul"); section.append(ul); } const item = el("li"); appendMarkdownInline(item, list[1], file); ul.append(item); continue; }
    if (line) section.append(markdownInline(line, file));
  }
  flushCode(); return section;
}
function markdownInline(line: string, file?: ResourceRef) {
  const paragraph = el("p"); appendMarkdownInline(paragraph, line, file); return paragraph;
}
function appendMarkdownInline(container: HTMLElement, line: string, file?: ResourceRef) {
  const pattern = /\[([^\]]+)\]\(([^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g; let cursor = 0;
  for (const match of line.matchAll(pattern)) { container.append(document.createTextNode(line.slice(cursor, match.index))); if (match[1]) { if (/^https?:\/\//.test(match[2])) { const link = safeLink(match[2]); link.textContent = match[1]; container.append(link); } else { const relative = relativeFileRef(file, match[2]); if (relative) container.append(button(match[1], () => void openResource(descriptor(relative, match[1])), "subtle")); else container.append(document.createTextNode(match[1])); } } else if (match[3]) container.append(el("code", "", match[3])); else container.append(el("strong", "", match[4])); cursor = (match.index || 0) + match[0].length; }
  container.append(document.createTextNode(line.slice(cursor)));
}
function relativeFileRef(file: ResourceRef | undefined, href: string): ResourceRef | undefined {
  if (!file?.root_id || !file.path || !state.workspace || href.startsWith("/") || href.startsWith("//") || href.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.includes("\\")) return undefined;
  const rawPath = href.split(/[?#]/, 1)[0]; if (!rawPath) return undefined;
  let relativePieces: string[];
  try { relativePieces = rawPath.split("/").map((piece) => decodeURIComponent(piece)); } catch { return undefined; }
  if (relativePieces.some((piece) => piece.includes("/") || piece.includes("\\") || piece.includes("\0"))) return undefined;
  const pieces = [...file.path.split("/").slice(0, -1), ...relativePieces]; const output: string[] = [];
  for (const piece of pieces) { if (!piece || piece === ".") continue; if (piece === "..") { if (!output.length) return undefined; output.pop(); } else output.push(piece); }
  return { kind: "file", workspace_id: state.workspace.id, root_id: file.root_id, path: output.join("/"), revision: file.revision };
}
function artifactKey(rootId: string, path: string) { return `${rootId}:${path}`; }

function renderArtifactTree(section?: HTMLElement) {
  const target = section || document.querySelector<HTMLElement>("#artifact-tree");
  if (!target || !state.workspace) return;
  target.querySelectorAll(":scope > .artifact-root, :scope > .artifact-empty").forEach((node) => node.remove());
  if (!state.artifactRoots.length) {
    target.append(el("p", "artifact-empty muted", "Loading artifact roots…"));
    return;
  }
  for (const rootValue of state.artifactRoots) {
    const root = object(rootValue); const rootId = string(root.id); const label = string(root.name) || rootId;
    const container = el("div", "artifact-root");
    if (root.exists === false) {
      container.append(el("p", "tree-label", label), el("p", "muted", "No artifacts yet. Attach a file in a chat to add one."));
      target.append(container); continue;
    }
    const key = artifactKey(rootId, "");
    const toggle = button(`${state.artifactExpanded.has(key) ? "▾" : "▸"} ${label}`, () => toggleArtifactDirectory(rootId, ""), "subtle artifact-toggle");
    container.append(toggle);
    if (state.artifactExpanded.has(key)) container.append(renderArtifactEntries(rootId, ""));
    target.append(container);
  }
}

function renderArtifactEntries(rootId: string, path: string): HTMLElement {
  const list = el("div", "tree-children"); const entries = state.artifactEntries.get(artifactKey(rootId, path));
  if (!entries) { list.append(el("p", "muted", "Loading…")); return list; }
  if (!entries.length) { list.append(el("p", "muted", "Empty folder")); return list; }
  for (const value of entries) {
    const item = object(value); const itemPath = string(item.path); const title = string(item.name) || itemPath; const type = string(item.kind);
    if (type === "directory") {
      const key = artifactKey(rootId, itemPath); const row = el("div", "artifact-directory");
      row.append(button(`${state.artifactExpanded.has(key) ? "▾" : "▸"} ${title}`, () => toggleArtifactDirectory(rootId, itemPath), "subtle artifact-toggle"));
      if (state.artifactExpanded.has(key)) row.append(renderArtifactEntries(rootId, itemPath));
      list.append(row);
    } else if (type === "file") {
      list.append(button(title, () => void openResource(descriptor({ kind: "file", workspace_id: state.workspace!.id, root_id: rootId, path: itemPath }, title)), "subtle artifact-file"));
    } else {
      list.append(el("p", "artifact-special muted", `${title} · ${type || "special entry"}`));
    }
  }
  return list;
}

async function loadArtifactRoots() {
  if (!state.workspace) return; const workspaceId = state.workspace.id;
  try {
    const result = await call("artifact_roots", { workspace_id: workspaceId });
    if (state.workspace?.id !== workspaceId) return;
    state.artifactRoots = array(result.roots).map(object);
    renderArtifactTree();
  } catch (error) { notice(message(error), "error"); }
}

async function toggleArtifactDirectory(rootId: string, path: string) {
  if (!state.workspace) return; const workspaceId = state.workspace.id; const key = artifactKey(rootId, path);
  if (state.artifactExpanded.has(key)) { state.artifactExpanded.delete(key); renderArtifactTree(); return; }
  state.artifactExpanded.add(key); renderArtifactTree();
  if (state.artifactEntries.has(key)) return;
  await loadArtifactDirectory(workspaceId, rootId, path);
}

async function loadArtifactDirectory(workspaceId: string, rootId: string, path: string) {
  const key = artifactKey(rootId, path);
  try {
    const result = await call("artifact_list", { workspace_id: workspaceId, root_id: rootId, path });
    if (state.workspace?.id !== workspaceId || !state.artifactExpanded.has(key)) return;
    state.artifactEntries.set(key, array(result.entries).map(object));
    renderArtifactTree();
  } catch (error) { notice(message(error), "error"); }
}

function isSystemChannel(value: unknown) {
  const item = object(value);
  const text = `${identifier(item)} ${string(item.name)}`.toLowerCase();
  return text.includes("orchard-system") || text.includes("task-receipt") || text.includes("task-receipts");
}

function withUnread(label: string, key: string) {
  const count = state.unread.get(key) || 0;
  return count ? `${label} (${count})` : label;
}

function conversationKey(entry: Json): string {
  const destination = object(entry.destination);
  const kind = string(destination.kind);
  if (kind === "channel") return `channel:${string(destination.id)}`;
  if (kind === "broadcast") return "broadcast:broadcast";
  if (kind === "direct") {
    const sender = string(entry.sender_id); const recipient = string(destination.id);
    return `direct:${sender === "owner" ? recipient : recipient === "owner" ? sender : "__all_direct__"}`;
  }
  return "";
}

function currentConversationKey() {
  return state.selectedConversation ? `${state.conversationKind}:${state.selectedConversation}` : "";
}

function observeMessages(entries: unknown[]) {
  for (const value of entries) {
    const entry = object(value); const id = string(entry.id); const key = conversationKey(entry);
    if (!id || !key || state.seenMessageIds.has(id)) continue;
    state.seenMessageIds.add(id);
    if (key !== currentConversationKey()) state.unread.set(key, (state.unread.get(key) || 0) + 1);
  }
}

function markCurrentConversationRead(entries: unknown[]) {
  for (const value of entries) { const id = string(object(value).id); if (id) state.seenMessageIds.add(id); }
  const key = currentConversationKey();
  if (key) state.unread.set(key, 0);
  if (state.conversationKind === "direct" && state.selectedConversation !== "__all_direct__") state.unread.set("direct:__all_direct__", 0);
}

function snapshotErrors() {
  return array(state.snapshot?.errors).map((entry) => {
    const item = object(entry);
    return [string(item.source), string(item.error)].filter(Boolean).join(": ") || "Unknown source error";
  });
}

function taskBackendErrors() {
  if (!state.taskBackend || state.taskBackend.available !== false) return [];
  return [`task backend: ${string(state.taskBackend.error) || string(state.taskBackend.reason) || "unavailable"}`];
}

async function selectConversation(kind: ConversationKind, id: string, fromResource = false) {
  if (state.workspace) {
    const tab: AppTab = kind === "direct" && id === "__all_direct__" ? collectionTab("directs", state.workspace.id) : descriptor(kind === "channel" ? { kind: "channel", workspace_id: state.workspace.id, id } : kind === "direct" ? { kind: "direct", workspace_id: state.workspace.id, id } : { kind: "broadcast", workspace_id: state.workspace.id }, kind === "broadcast" ? "Broadcast" : kind === "channel" ? channelLabel(id) : participantLabel(participantName(id)));
    const existing = prepareTab(tab);
    existing.title = tab.title;
    state.activeHref = tab.href; state.activeResource = isDescriptor(tab) ? tab : undefined; state.resourceLinks = {}; state.navigationEpoch += 1; patchTabs();
    if (!fromResource) history.pushState({ screen: "workspace", workspaceId: state.workspace.id, resourceHref: tab.href }, "", tab.href);
  }
  state.selectedConversation = id;
  state.conversationKind = kind;
  state.agentData = undefined; state.agentLinks = undefined;
  state.replyTo = undefined;
  state.conversationMessages = [];
  patchConversations();
  patchConversation();
  const active = state.activeResource; const epoch = state.navigationEpoch;
  await Promise.all([loadHistory(id), active && id !== "__all_direct__" ? loadConversationResource(active, epoch) : Promise.resolve(), kind === "direct" && id !== "__all_direct__" ? loadAgentContext(id, epoch) : Promise.resolve()]);
}

async function loadAgentContext(id: string, epoch: number) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.id;
  try {
    const ref: ResourceRef = { kind: "agent", workspace_id: workspaceId, id };
    const result = await call("resource_get", { workspace_id: workspaceId, ref });
    if (state.workspace?.id !== workspaceId || state.navigationEpoch !== epoch || state.conversationKind !== "direct" || state.selectedConversation !== id) return;
    state.agentData = object(result.resource); state.agentLinks = object(result.links);
    patchAgentContext();
  } catch (error) { if (state.workspace?.id === workspaceId && state.navigationEpoch === epoch) notice(message(error), "error"); }
}

function patchAgentContext() {
  document.querySelector<HTMLElement>(".agent-context")?.remove();
  if (state.conversationKind !== "direct" || !state.selectedConversation || state.selectedConversation === "__all_direct__") return;
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel) return;
  const identity = object(object(state.agentData).data).participant;
  const participant = object(identity);
  const fallback = mailList("participants").map(object).find((person) => identifier(person) === state.selectedConversation) || {};
  const person = Object.keys(participant).length ? participant : fallback;
  const context = el("section", "agent-context");
  context.append(el("strong", "", participantLabel(string(person.name) || state.selectedConversation)));
  const registered = string(person.registered_at) || string(person.created_at);
  const contacted = string(person.last_contact_at);
  context.append(el("span", "muted", `${person.registered === false ? "Not registered" : registered ? `Registered ${registered}` : "Registered"} · ${contacted ? `Last contact ${contacted}` : "No recorded contact"}`));
  const related = [...array(state.agentLinks?.outgoing).map((value) => ({ value, key: "target" })), ...array(state.agentLinks?.incoming).map((value) => ({ value, key: "source" }))];
  if (related.length) {
    const links = el("div", "agent-related");
    for (const relation of related) {
      const item = object(relation.value); const ref = object(item[relation.key]) as ResourceRef;
      if (!ref.kind || ref.workspace_id !== state.workspace?.id || (ref.kind === "agent" && ref.id === state.selectedConversation)) continue;
      const label = string(item.label) || string(ref.path) || string(ref.id) || string(ref.task_id) || ref.kind;
      links.append(button(label, () => void openResource(descriptor(ref, label)), "subtle"));
    }
    if (links.childElementCount) context.append(links);
  }
  panel.querySelector(".conversation-title")?.after(context);
}

async function loadConversationResource(active: Descriptor, epoch: number) {
  const workspaceId = active.ref.workspace_id;
  try {
    const result = await call("resource_get", { workspace_id: workspaceId, ref: active.ref });
    if (state.workspace?.id !== workspaceId || state.activeHref !== active.href || state.navigationEpoch !== epoch) return;
    state.resourceData = object(result.resource); state.resourceLinks = object(result.links); patchConversationLinks();
  } catch (error) {
    if (state.workspace?.id === workspaceId && state.activeHref === active.href && state.navigationEpoch === epoch) notice(message(error), "error");
  }
}

function patchConversationLinks() {
  const panel = document.querySelector<HTMLElement>("#conversation");
  if (!panel || !state.activeResource || !["channel", "direct", "broadcast"].includes(state.activeResource.kind)) return;
  panel.querySelectorAll(":scope > .resource-actions, :scope > .related-links").forEach((node) => node.remove());
  appendResourceActions(panel, state.activeResource, state.resourceLinks || {});
}

function patchConversation() {
  const panel = document.querySelector<HTMLElement>("#conversation");
  if (!panel || !state.workspace) return;
  panel.replaceChildren();
  const title = state.selectedConversation ? (state.conversationKind === "broadcast" ? "Broadcast" : state.conversationKind === "direct" ? state.selectedConversation === "__all_direct__" ? "All direct messages" : participantLabel(participantName(state.selectedConversation)) : channelLabel(state.selectedConversation)) : "Choose a conversation";
  const heading = el("header", "conversation-title");
  if (state.workspace && state.selectedConversation) {
    const ref: ResourceRef = state.conversationKind === "channel" ? { kind: "channel", workspace_id: state.workspace.id, id: state.selectedConversation } : state.conversationKind === "direct" ? { kind: "direct", workspace_id: state.workspace.id, id: state.selectedConversation } : { kind: "broadcast", workspace_id: state.workspace.id };
    heading.append(button(title, () => void openResource(descriptor(ref, title)), "subtle"));
  } else heading.textContent = title;
  panel.append(heading);
  patchAgentContext();
  const thread = el("div", "thread");
  thread.id = "thread";
  const messages = state.selectedConversation ? state.conversationMessages : [];
  if (!state.selectedConversation) thread.append(el("p", "muted", "Channels, direct conversations and broadcasts appear here once they exist."));
  if (state.selectedConversation) renderMessageList(thread, messages, state.selectedConversation === "__all_direct__");
  panel.append(thread);
  if (state.selectedConversation && state.selectedConversation !== "__all_direct__") panel.append(composer());
  if (state.activeResource && ["channel", "direct", "broadcast"].includes(state.activeResource.kind)) appendResourceActions(panel, state.activeResource, state.resourceLinks || {});
}

function patchMessages() {
  const thread = document.querySelector<HTMLElement>("#thread");
  if (!thread || !state.selectedConversation) return;
  if (hasSelectionWithin(thread) || (document.activeElement !== document.body && thread.contains(document.activeElement))) { messagePatchPending = true; return; }
  messagePatchPending = false;
  const previousScroll = thread.scrollTop;
  const wasAtBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 32;
  thread.replaceChildren();
  renderMessageList(thread, state.conversationMessages, state.selectedConversation === "__all_direct__");
  if (wasAtBottom) thread.scrollTop = thread.scrollHeight;
  else thread.scrollTop = previousScroll;
}

function renderMessageList(thread: HTMLElement, messages: unknown[], showDestination = false) {
  thread.replaceChildren();
  for (const entry of messages) {
    const item = object(entry);
    const article = el("article", "message");
    const sender = participantLabel(participantName(string(item.sender_id)));
    const destination = object(item.destination);
    const recipient = string(destination.id);
    const meta = el("div", "message-meta");
    if (state.workspace && string(item.sender_id)) meta.append(button(showDestination && recipient ? `${sender} → ${participantLabel(participantName(recipient))}` : sender, () => void openResource(descriptor({ kind: "agent", workspace_id: state.workspace!.id, id: string(item.sender_id) }, sender)), "subtle message-sender"));
    else meta.append(el("strong", "message-sender", showDestination && recipient ? `${sender} → ${participantLabel(participantName(recipient))}` : sender));
    const sentAt = string(item.sent_at) || string(item.created_at) || string(item.timestamp);
    if (sentAt) {
      const date = new Date(sentAt);
      const label = Number.isNaN(date.valueOf()) ? sentAt : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
      if (state.workspace && string(item.id)) meta.append(button(label, () => void openResource(descriptor({ kind: "message", workspace_id: state.workspace!.id, id: string(item.id) }, "Message")), "subtle message-time"));
      else meta.append(el("time", "message-time", label));
    }
    article.append(meta);
    article.append(messageBody(string(item.body) || string(item.content)));
    for (const ref of array(item.refs)) article.append(referenceNode(ref));
    if (string(item.thread_id)) article.append(el("p", "muted", "In reply to an earlier message"));
    if (string(item.id) && state.selectedConversation !== "__all_direct__") article.append(button("Reply", () => { state.replyTo = string(item.id); const revisionKey = `${state.workspace?.id}:${draftKey()}`; state.replyRevision.set(revisionKey, (state.replyRevision.get(revisionKey) || 0) + 1); patchConversation(); }, "subtle reply-button"));
    thread.append(article);
  }
  if (!messages.length) thread.append(el("p", "muted", "No messages yet."));
}

function draftKey() { return `${state.conversationKind}:${state.selectedConversation || ""}`; }

function refreshDraftAttachment(key: string) {
  for (const form of document.querySelectorAll<HTMLElement>(".composer")) if (form.dataset.draftKey === key) form.dispatchEvent(new Event("draftattachmentchange"));
}

function refreshDraftDelivery(workspaceId: string, key: string) {
  for (const form of document.querySelectorAll<HTMLElement>(".composer")) {
    if (form.dataset.workspaceId === workspaceId && form.dataset.draftKey === key) form.dispatchEvent(new Event("draftdeliverychange"));
  }
}

function composer() {
  const form = el("form", "composer");
  const input = document.createElement("textarea");
  const key = draftKey();
  const previousDraft = state.drafts.get(key);
  input.value = previousDraft?.body || "";
  input.rows = 3;
  input.placeholder = state.replyTo ? "Write a reply" : "Write a message";
  input.setAttribute("aria-label", "Message");
  const workspaceId = state.workspace!.id;
  const attachmentArea = el("div", "attachment-area");
  const deliveryArea = el("div", "mail-delivery-area");
  const pendingKey = `${workspaceId}:${key}`;
  const noticeForDraft = (text: string, tone: "error" | "info" = "info") => {
    if (state.screen === "workspace" && state.workspace?.id === workspaceId && draftKey() === key) notice(text, tone);
  };
  const file = document.createElement("input");
  file.type = "file"; file.hidden = true; file.tabIndex = -1; file.setAttribute("aria-hidden", "true");

  const saveBody = () => {
    const current = state.drafts.get(key);
    state.drafts.set(key, { body: input.value, attachment: current?.attachment });
  };

  const renderAttachment = () => {
    attachmentArea.replaceChildren();
    const attachment = state.drafts.get(key)?.attachment;
    if (!attachment) return;
    const chip = el("span", `attachment-chip ${attachment.status}`);
    const status = attachment.status === "uploading" ? " · Uploading…" : attachment.status === "failed" ? " · Upload failed" : "";
    chip.append(el("span", "attachment-name", `${attachment.name}${status}`));
    if (attachment.status === "failed" && attachment.file) chip.append(button("Retry", () => void uploadAttachment(attachment.file!, attachment.requestId), "attachment-retry subtle"));
    const remove = button("×", () => {
      const current = state.drafts.get(key);
      if (!current || current.attachment?.requestId !== attachment.requestId) return;
      state.drafts.set(key, { body: current.body });
      renderAttachment();
    }, "attachment-remove subtle");
    remove.setAttribute("aria-label", `Remove attachment ${attachment.name}`);
    chip.append(remove); attachmentArea.append(chip);
  };

  const uploadAttachment = async (selected: File, requestId: string = crypto.randomUUID()) => {
    if (!workspaceId) return;
    const current = state.drafts.get(key);
    const pending: DraftAttachment = { name: selected.name, requestId, status: "uploading", file: selected };
    state.drafts.set(key, { body: current?.body ?? input.value, attachment: pending });
    renderAttachment();
    if (selected.size > 512 * 1024) {
      pending.status = "failed"; pending.error = "Attachments must be 512 KiB or smaller.";
      refreshDraftAttachment(key); notice(pending.error, "error"); return;
    }
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await call("artifact_upload", { workspace_id: workspaceId, path: selected.name, content_base64: btoa(binary), request_id: requestId });
      const originating = state.drafts.get(key);
      if (originating?.attachment?.requestId !== requestId) return;
      const resource = object(result.resource); const ref = object(resource.ref) as ResourceRef;
      if (!ref.kind || ref.workspace_id !== workspaceId) throw new Error("Upload did not return a workspace resource.");
      const ready: DraftAttachment = { name: selected.name, requestId, status: "ready", href: string(resource.href) || canonicalHref(ref), ref };
      state.drafts.set(key, { body: originating.body, attachment: ready });
      if (state.workspace?.id === workspaceId && draftKey() === key) { refreshDraftAttachment(key); notice("Attachment uploaded."); }
      if (ref.kind === "file" && ref.root_id && state.workspace?.id === workspaceId) {
        const rootKey = artifactKey(ref.root_id, ""); state.artifactEntries.delete(rootKey);
        if (state.artifactExpanded.has(rootKey)) void loadArtifactDirectory(workspaceId, ref.root_id, "");
        void loadArtifactRoots();
      }
    } catch (error) {
      const originating = state.drafts.get(key);
      if (originating?.attachment?.requestId !== requestId) return;
      state.drafts.set(key, { body: originating.body, attachment: { ...originating.attachment, status: "failed", file: selected, error: message(error) } });
      if (state.workspace?.id === workspaceId && draftKey() === key) { refreshDraftAttachment(key); notice(message(error), "error"); }
    }
  };

  const finishMail = async (pending: PendingMail) => {
    if (state.pendingMail.get(pendingKey) !== pending) return;
    state.pendingMail.delete(pendingKey);
    if (state.workspace?.id !== workspaceId) return;
    const currentDraft = state.drafts.get(key);
    if (currentDraft?.body === pending.draftBody && currentDraft.attachment?.requestId === pending.attachmentRequestId && (state.replyRevision.get(pendingKey) || 0) === pending.replyRevision) state.drafts.delete(key);
    if (draftKey() !== key) return;
    if (!state.drafts.has(key)) state.replyTo = undefined;
    refreshDraftDelivery(workspaceId, key);
    if (state.selectedConversation) await loadHistory(state.selectedConversation);
  };

  const renderDelivery = () => {
    deliveryArea.replaceChildren();
    const pending = state.pendingMail.get(pendingKey);
    if (pending?.state !== "uncertain") return;
    const warning = el("div", "mail-delivery-warning");
    warning.append(el("p", "", "Delivery is uncertain. The original message may already be present. Retry uses the same request and content, even if you edit this draft."));
    const retry = button("Retry original message", async () => {
      if (pending.state !== "uncertain") return;
      pending.state = "sending"; retry.disabled = true; abandon.disabled = true;
      try { await call("mail_send", pending.args); await finishMail(pending); noticeForDraft("Original message confirmed."); }
      catch (error) { pending.state = "uncertain"; refreshDraftDelivery(workspaceId, key); noticeForDraft(`Original message remains uncertain: ${message(error)}`, "error"); }
      finally { retry.disabled = false; abandon.disabled = false; if (document.contains(deliveryArea)) renderDelivery(); }
    }, "subtle mail-retry");
    const abandon = button("Keep draft as new message", () => {
      if (pending.state !== "uncertain" || state.pendingMail.get(pendingKey) !== pending) return;
      state.pendingMail.delete(pendingKey); renderDelivery();
      notice("Original delivery may have succeeded. Your next Send creates a separate message.");
    }, "subtle");
    warning.append(actionRow(retry, abandon)); deliveryArea.append(warning);
  };

  const send = button("Send", async () => {
    if (!state.workspace) return;
    if (send.disabled) return;
    if (state.pendingMail.has(pendingKey)) return notice("Resolve the uncertain original message before sending this draft.", "error");
    const draft = state.drafts.get(key) || { body: input.value };
    const attachment = draft.attachment;
    if (attachment?.status === "uploading") return notice("Wait for the attachment to finish uploading.", "error");
    if (attachment?.status === "failed") return notice("Retry or remove the failed attachment before sending.", "error");
    const body = input.value.trim() || (attachment ? `Attached ${attachment.name}` : "");
    if (!body) return notice("Write a message or attach a file.", "error");
    send.disabled = true;
    const kind = state.conversationKind;
    const id = state.selectedConversation;
    const target = kind === "broadcast" ? { kind } : { kind, id };
    if (kind !== "broadcast" && !id) { send.disabled = false; return notice("Choose a conversation first.", "error"); }
    const refs = attachment?.ref ? [{ type: "resource", resource: attachment.ref }] : [];
    const pending: PendingMail = { args: { workspace_id: workspaceId, request_id: crypto.randomUUID(), sender_id: "owner", destination: target, body, kind: "message", thread_id: state.replyTo, refs }, draftBody: input.value, attachmentRequestId: attachment?.requestId, replyRevision: state.replyRevision.get(pendingKey) || 0, state: "sending" };
    state.pendingMail.set(pendingKey, pending);
    try { await call("mail_send", pending.args); await finishMail(pending); }
    catch (error) { pending.state = "uncertain"; refreshDraftDelivery(workspaceId, key); noticeForDraft(`Delivery is uncertain: ${message(error)}. Retry the original message.`, "error"); }
    finally { if (document.contains(send)) send.disabled = false; }
  }, "primary");
  form.addEventListener("submit", (event) => { event.preventDefault(); send.click(); });
  const destination = el("p", "muted", `To ${state.conversationKind === "broadcast" ? "everyone" : state.conversationKind === "direct" ? participantLabel(participantName(state.selectedConversation || "")) : channelLabel(state.selectedConversation || "")}`);
  const attach = button("", () => file.click(), "attach-button subtle");
  attach.setAttribute("aria-label", "Attach file"); attach.title = "Attach file";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M9.5 17.5 17 10a3.5 3.5 0 0 0-5-5l-8 8a5 5 0 0 0 7 7l8-8");
  icon.append(path); attach.append(icon);
  file.addEventListener("change", () => { const selected = file.files?.[0]; file.value = ""; if (selected) void uploadAttachment(selected); });
  input.addEventListener("input", saveBody);
  const attachmentControls = el("div", "attachment-controls"); attachmentControls.append(attach, file, attachmentArea);
  form.dataset.draftKey = key; form.dataset.workspaceId = workspaceId;
  form.addEventListener("draftattachmentchange", renderAttachment);
  form.addEventListener("draftdeliverychange", () => { if (!state.drafts.has(key)) { input.value = ""; renderAttachment(); } renderDelivery(); });
  renderAttachment();
  renderDelivery();
  form.append(destination, input, attachmentControls, deliveryArea, send);
  return form;
}

function attachmentRef(value: string): ResourceRef | undefined {
  if (!value || !state.workspace) return undefined;
  const orchard = parseHref(value, state.workspace.id); if (orchard) return orchard;
  try { const url = new URL(value); if (url.protocol === "https:" || url.protocol === "http:") return { kind: "url", workspace_id: state.workspace.id, url: url.href }; } catch { /* validation below */ }
  notice("Use an Orchard resource link or an HTTP(S) URL.", "error"); return undefined;
}

function basename(path: string) { return path.split("/").filter(Boolean).at(-1) || ""; }
function taskStoreButton(item: Json, label?: string) {
  const store = object(item.store); const id = identifier(store) || string(store.store_id);
  return button(label || string(store.name) || basename(string(store.path)) || id, () => selectStore(item), `${state.store?.id === id ? "selected " : ""}subtle store-button`);
}
function openTasks() {
  const owned = workspaceStores().map(object).find((item) => string(object(item.store).source) === "owned" || identifier(object(item.store)) === "default");
  if (owned && !state.store) selectStore(owned);
  if (state.workspace) void activateTab(collectionTab("tasks", state.workspace.id));
}
function renderTaskCollection() {
  if (!state.workspace) return;
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel) return; panel.replaceChildren(el("header", "conversation-title", "Tasks"));
  const attached = pluginAttached("tasks", true);
  if (!attached) panel.append(el("p", "muted", "Tasks is detached. Preserved task records are read-only."));
  const actions = el("div", "resource-actions"); const addProject = button("Add project", () => void attachRepository(), "subtle"); addProject.disabled = !attached; actions.append(addProject); panel.append(actions);
  const stores = workspaceStores().map(object);
  if (!stores.length) { panel.append(el("p", "empty-state muted", "No task stores are connected.")); return; }
  const picker = el("div", "collection-picker");
  for (const item of stores) picker.append(taskStoreButton(item));
  panel.append(picker);
  if (state.store) patchTaskPanel(panel); else panel.append(el("p", "muted", "Choose a task store."));
}

function renderAgentCollection() {
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel || !state.workspace) return;
  panel.replaceChildren(el("header", "conversation-title", "Agents"));
  const participants = mailList("participants").map(object).filter((person) => identifier(person) !== "owner" && identifier(person) !== "orchard");
  if (!participants.length) panel.append(el("p", "empty-state muted", "No connected agents yet."));
  for (const participant of participants) {
    const id = identifier(participant); const name = string(participant.name) || id;
    const row = el("article", "agent-card"); row.append(button(name, () => void openResource(descriptor({ kind: "agent", workspace_id: state.workspace!.id, id }, name)), "subtle"));
    if (string(participant.last_contact_at)) row.append(el("p", "muted", `Last contact ${string(participant.last_contact_at)}`)); else row.append(el("p", "muted", participant.registered === false ? "Not registered; no recorded contact yet." : "Registered; no recorded contact yet."));
    panel.append(row);
  }
  const actions = el("div", "resource-actions"); actions.append(button("Connection settings", showAgentForm, "subtle")); panel.append(actions);
}
function renderStateCollection() {
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel || !state.workspace) return;
  panel.replaceChildren(el("header", "conversation-title", "State"));
  const picker = el("div", "collection-picker");
  const markers = button("All markers", () => { state.stateCollectionMode = "markers"; renderStateCollection(); }, state.stateCollectionMode === "markers" ? "selected subtle" : "subtle");
  const opportunities = button("Work opportunities", () => { state.stateCollectionMode = "opportunities"; renderStateCollection(); }, state.stateCollectionMode === "opportunities" ? "selected subtle" : "subtle");
  picker.append(markers, opportunities); panel.append(picker);
  if (state.stateCollectionMode === "opportunities") {
    if (state.stateOpportunitiesWorkspace !== state.workspace.id) { panel.append(el("p", "muted", "Loading work opportunities…")); void loadStateOpportunities(); return; }
    if (stateOpportunitiesError) { const error = el("p", "error", `Work opportunities are unavailable: ${stateOpportunitiesError}`); const retry = button("Retry", () => void loadStateOpportunities(true), "subtle"); panel.append(error, retry); return; }
    if (!state.stateOpportunities.length) { panel.append(el("p", "empty-state muted", "No work opportunities right now.")); return; }
    for (const opportunity of state.stateOpportunities) {
      const marker = object(opportunity.marker); const id = identifier(marker); if (!id) continue;
      const title = string(marker.title) || id; const transitions = array(opportunity.transitions).map(object);
      const ready = transitions.filter((transition) => string(transition.readiness) === "ready").length;
      const row = el("article", "state-opportunity"); const label = `${title} · ${string(marker.state) || "unknown"}${ready ? ` · ${ready} ready` : ""}`;
      row.append(button(label, () => void openResource(descriptor({ kind: "state", workspace_id: state.workspace!.id, id }, title)), "conversation-button"));
      const guidance = object(opportunity.guidance); if (string(guidance.instructions)) row.append(el("p", "muted", string(guidance.instructions)));
      const blocked = transitions.find((transition) => string(transition.readiness) === "blocked" || string(transition.readiness) === "needs_input");
      const reasons = array(blocked?.reasons).map(string).filter(Boolean); if (reasons.length) row.append(el("p", "state-transition-reasons", reasons.join(" · ")));
      panel.append(row);
    }
    return;
  }
  if (!state.stateMarkers.length && state.stateMarkersWorkspace !== state.workspace.id) { panel.append(el("p", "muted", "Loading state markers…")); void loadStateMarkers(); return; }
  if (!pluginAttached("state")) panel.append(el("p", "muted", "State is detached. Preserved marker data is read-only."));
  if (stateMarkersError) { panel.append(el("p", "error", `State is unavailable: ${stateMarkersError}`), button("Retry", () => void loadStateMarkers(true), "subtle")); return; }
  if (!stateMarkersError && !state.stateMarkers.length) panel.append(el("p", "empty-state muted", "No state markers yet. Agents can attach definitions and create markers as part of their work."));
  for (const marker of state.stateMarkers) { const id = identifier(marker); const title = string(marker.title) || id; panel.append(button(`${title} · ${string(marker.state) || "unknown"}`, () => void openResource(descriptor({ kind: "state", workspace_id: state.workspace!.id, id }, title)), "conversation-button")); }
}
function renderStateCollectionRetained() {
  const panel = document.querySelector<HTMLElement>("#conversation");
  const scroll = panel?.scrollTop || 0;
  const focused = document.activeElement instanceof HTMLButtonElement && panel?.contains(document.activeElement) ? document.activeElement.textContent : undefined;
  renderStateCollection();
  if (!panel) return;
  panel.scrollTop = scroll;
  if (focused) [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === focused)?.focus();
}
function selectStore(item: Json) {
  const store = object(item.store); const id = identifier(store) || string(store.store_id);
  if (!id) return;
  state.store = { id, path: string(store.path), name: string(store.name), source: string(store.source) };
  state.selectedTask = undefined;
  state.snapshot = { ...state.snapshot, tasks: array(item.tasks) };
  void loadTasks();
}

async function loadHistory(channelId: string) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.id;
  const kind = state.conversationKind;
  const request = ++state.conversationRequest;
  try {
    const args: Json = { workspace_id: workspaceId, destination_kind: kind, latest: true, limit: 100 };
    if (kind === "channel") args.channel_id = channelId;
    const history = await call("mail_history", args);
    let messages = array(history.messages);
    if (kind === "direct" && channelId !== "__all_direct__") messages = messages.filter((value) => {
      const item = object(value); const destination = string(object(item.destination).id); const sender = string(item.sender_id);
      return (sender === "owner" && destination === channelId) || (sender === channelId && destination === "owner");
    });
    if (request !== state.conversationRequest || state.workspace?.id !== workspaceId || state.conversationKind !== kind || state.selectedConversation !== channelId) return;
    if (!(state.activeResource && ["channel", "direct", "broadcast"].includes(state.activeResource.kind)) && state.activeHref !== collectionTab("directs", workspaceId).href) return;
    state.conversationMessages = messages;
    markCurrentConversationRead(messages);
    patchConversations();
    patchMessages();
  } catch (error) { notice(message(error), "error"); }
}

function showInlineForm(title: string, fields: Array<[string, string, string]>, submitLabel: string, action: (values: Record<string, string>, stillActive: () => boolean) => Promise<void>) {
  const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel) return;
  const returnTab = state.tabs.find((tab) => tab.href === state.activeHref);
  state.formReturn = returnTab;
  navigate("workspace", "form");
  const formEpoch = state.detailEpoch;
  const returnToViewer = () => { state.formReturn = undefined; state.detailView = undefined; if (returnTab) void activateTab(returnTab, true); else renderEmptyViewer(); };
  const content = el("section", "viewer-content form-view");
  content.append(button("Back", returnToViewer, "close-button subtle"), el("h2", "", title));
  const form = el("form", "stack"); const inputs = new Map<string, HTMLInputElement>();
  for (const [name, label, placeholder] of fields) { const input = document.createElement("input"); input.name = name; input.required = true; input.placeholder = placeholder; input.setAttribute("aria-label", label); inputs.set(name, input); form.append(el("label", "", label), input); }
  const submit = button(submitLabel, async () => { const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value.trim()])); if (Object.values(values).some((value) => !value)) return notice("Complete each field.", "error"); if (submit.disabled) return; submit.disabled = true; try { const stillActive = () => state.detailEpoch === formEpoch && state.detailView === "form"; await action(values, stillActive); if (stillActive()) returnToViewer(); } finally { if (document.contains(submit)) submit.disabled = false; } }, "primary");
  form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); }); form.append(actionRow(submit, button("Cancel", returnToViewer, "subtle"))); content.append(form); panel.replaceChildren(content);
}

function showChannelForm() {
  if (!state.workspace) return;
  showInlineForm("New channel", [["name", "Channel name", "Project updates"]], "Create channel", async ({ name }, stillActive) => {
    try { await call("mail_channel_create", { workspace_id: state.workspace!.id, request_id: crypto.randomUUID(), name }); await refreshSnapshot(); void stillActive; }
    catch (error) { notice(message(error), "error"); }
  });
}

function showAgentForm() {
  renderSettings();
}

async function attachRepository() {
  if (!state.workspace) return;
  showInlineForm("Add project", [["path", "Project path", "/path/to/repository"]], "Add project", async ({ path }, stillActive) => {
    try { await call("repository_attach", { workspace_id: state.workspace!.id, path }); await refreshSnapshot(); void stillActive; }
    catch (error) { notice(message(error), "error"); }
  });
}

async function loadTasks() {
  if (!state.workspace || !state.store) return;
  const workspaceId = state.workspace.id; const storeId = state.store.id; const request = ++state.taskRequest;
  try {
    const tasks = await call("tasks_list", { workspace_id: workspaceId, store_id: storeId });
    if (request !== state.taskRequest || state.workspace?.id !== workspaceId || state.store?.id !== storeId) return;
    const loaded = array(tasks.tasks ?? tasks.items ?? tasks);
    const taskStores = workspaceStores().map((value) => {
      const item = object(value);
      return identifier(object(item.store)) === storeId ? { ...item, tasks: loaded } : value;
    });
    state.snapshot = { ...state.snapshot, task_stores: taskStores };
    patchConversations();
    if (state.activeHref === collectionTab("tasks", workspaceId).href) renderTaskCollection();
  } catch (error) { notice(message(error), "error"); }
}

function patchTaskPanel(panel: HTMLElement) {
  const section = el("section", "task-panel");
  const selectedStore = workspaceStores().map(object).find((item) => identifier(object(item.store)) === state.store?.id);
  const create = button("New task", () => void createTask(), "subtle task-create");
  create.disabled = !pluginAttached("tasks", true) || !selectedStore || selectedStore.tasks === null;
  if (create.disabled) create.title = pluginAttached("tasks", true) ? "This task source is unavailable." : "Tasks is detached; retained data is read-only.";
  section.append(create);
  if (selectedStore && selectedStore.tasks === null) {
    section.append(el("p", "error", "This task store is unavailable. Orchard has not substituted empty task data."));
    panel.append(section);
    return;
  }
  const filter = document.createElement("select"); filter.className = "task-filter"; filter.setAttribute("aria-label", "Filter tasks by status");
  for (const [value, label] of [["all", "All statuses"], ["open", "Open"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["closed", "Closed"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = state.taskFilter === value; filter.append(option);
  }
  filter.addEventListener("change", () => { state.taskFilter = filter.value as typeof state.taskFilter; renderTaskCollection(); });
  section.append(filter);
  let visible = 0;
  for (const item of array(selectedStore?.tasks)) {
    const task = object(item);
    if (state.taskFilter !== "all" && string(task.status) !== state.taskFilter) continue;
    const id = string(task.task_id) || identifier(task);
    const row = el("div", "task-list-row");
    row.append(button(`${id} ${string(task.title)}`, () => { state.selectedTask = id; void openResource(descriptor({ kind: "task", workspace_id: state.workspace!.id, store_id: state.store!.id, task_id: id }, string(task.title) || `Task ${id}`)); }, state.selectedTask === id ? "selected subtle" : "subtle"), el("span", "task-summary", taskMetadata(task)));
    section.append(row); visible += 1;
  }
  if (!visible) section.append(el("p", "muted", "No tasks match this status."));
  panel.append(section);
}

async function createTask() {
  if (!state.workspace || !state.store) return;
  const workspaceId = state.workspace.id; const storeId = state.store.id;
  showInlineForm("New task", [["title", "Task title", "Describe the next action"]], "Create task", async ({ title }, stillActive) => {
    try { await call("task_create", { workspace_id: workspaceId, store_id: storeId, title, request_id: crypto.randomUUID() }); if (stillActive() && state.workspace?.id === workspaceId && state.store?.id === storeId) await loadTasks(); }
    catch (error) { notice(message(error), "error"); }
  });
}

function openWorkspaceFromSettings() {
  if (!state.workspace) return;
  const href = state.activeHref || workspaceRootHref(state.workspace.id);
  navigate("workspace", undefined, false, href);
  renderWorkspace();
  const active = state.tabs.find((tab) => tab.href === state.activeHref);
  if (active) void activateTab(active, true); else renderEmptyViewer();
}

function pluginCatalog() {
  const section = el("section", "settings-section plugin-catalog"); section.append(el("h2", "", "Bundled plugins"), el("p", "muted", "Core and Chat are required. Tasks and State can be attached to this workspace; detaching preserves their data for read-only views."));
  const catalog = plugins();
  if (!catalog.length) { section.append(el("p", "muted", "Plugin status is loading…")); return section; }
  for (const item of catalog) {
    const id = string(item.id); const row = el("article", "plugin-row"); const title = string(item.name) || id;
    row.append(el("h3", "", title), el("p", "muted", string(item.description) || "No description supplied."));
    const status = item.available === false ? "Unavailable" : item.required === true ? "Required" : item.attached === false ? "Detached" : "Attached";
    row.append(el("p", "task-metadata", `${status} · v${item.version === undefined ? "?" : String(item.version)}`));
    if (item.required !== true) {
      const control = button(item.attached === false ? "Attach" : "Detach", async () => {
        control.disabled = true; const operation = item.attached === false ? "plugin_attach" : "plugin_detach";
        try { await call(operation, { workspace_id: state.workspace!.id, plugin_id: id, request_id: crypto.randomUUID() }); await refreshSnapshot(["plugins", "tasks", "state"]); notice(`${title} ${operation === "plugin_attach" ? "attached" : "detached"}.`); }
        catch (error) { notice(message(error), "error"); }
        finally { if (document.contains(control)) control.disabled = false; }
      }, "subtle"); control.disabled = item.available === false; row.append(control);
      if (item.attached === false && item.available !== false) row.append(button("View retained data", () => { renderWorkspace(); if (id === "tasks") openTasks(); else void activateTab(collectionTab("states", state.workspace!.id)); }, "subtle"));
    }
    section.append(row);
  }
  return section;
}

function renderSettings(fromHistory = false) {
  if (!state.workspace) return;
  if (!fromHistory) navigate("settings", undefined, false, workspaceSettingsHref(state.workspace.id));
  shell("Workspace settings", "Share the workspace context with collaborators, or configure another already-running agent.");
  const panel = document.querySelector<HTMLElement>(".welcome");
  const overview = el("section", "settings-section");
  const introduction = el("div", "settings-introduction muted", "Loading workspace introduction…");
  const readme = el("div", "readme-summary"); readme.append(el("p", "muted", "Loading README…"));
  const joining = codeBlock("Loading joining prompt…");
  const workspacePath = codeBlock("Loading workspace path…");
  overview.append(el("h2", "", "Workspace introduction"), introduction, readme, el("h2", "", "Joining prompt"), el("p", "muted", "Paste this as a user message, not environment context, to one agent. Local agents can use the workspace credential file; other connections use Settings."), joining, el("h3", "", "Workspace path"), workspacePath);
  const endpoint = codeBlock("Not loaded");
  const token = codeBlock("Not loaded");
  const claudeConfig = codeBlock("Loading configuration…");
  const codexConfig = codeBlock("Loading configuration…");
  const codexToml = codeBlock("Loading configuration…");
  const back = () => button("Back to workspace", openWorkspaceFromSettings, "subtle");
  const archive = button("Archive workspace", () => {
    const confirmation = el("section", "stack");
    const confirm = button("Confirm archive workspace", async () => {
      try {
        await call("workspace_archive", { workspace_id: state.workspace!.id });
        await refreshWorkspaces();
        state.workspace = undefined;
        if (state.workspaces.length) await chooseWorkspace(state.workspaces[0].id);
        else renderEmptyWorkspace();
      } catch (error) { notice(message(error), "error"); }
    }, "primary");
    confirmation.append(el("p", "error", "Archive this workspace? Its data remains on disk, but it leaves the active workspace list."), actionRow(confirm, button("Cancel archive", () => confirmation.remove(), "subtle")));
    panel?.append(confirmation);
  }, "subtle");
  const rotate = button("Rotate credential", async () => {
    try { await call("rotate_token", { workspace_id: state.workspace!.id }); await loadConnection(endpoint, token, claudeConfig, codexConfig, codexToml); notice("Credential rotated. Replace the affected agent configuration, then reconnect it."); }
    catch (error) { notice(message(error), "error"); }
  }, "primary");
  const connection = document.createElement("details"); connection.className = "settings-section connection-details";
  connection.append(el("summary", "", "Connection details"), el("h2", "", "Endpoint"), endpoint, el("h2", "", "Credential"), token, el("p", "muted", "Each workspace gets its own MCP alias. Orchard does not launch or wake agents."), el("h3", "", "Claude Code"), claudeConfig, el("h3", "", "Codex"), codexConfig, el("h3", "", "Codex TOML"), codexToml, el("p", "muted", "For Codex, ORCHARD_TOKEN must exist in the process that launches the harness; exporting it in a terminal does not change an already-running app. After adding config, reconnect or reload MCP as the harness supports."), actionRow(rotate));
  panel?.append(back(), overview, pluginCatalog(), connection, actionRow(archive, back()));
  void loadWorkspaceIntroduction(introduction, readme, joining, workspacePath);
  void loadConnection(endpoint, token, claudeConfig, codexConfig, codexToml);
}

async function loadWorkspaceIntroduction(introduction: HTMLElement, readme: HTMLElement, joining: HTMLElement, workspacePathBlock: HTMLElement) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.id;
  try {
    const [intro, info] = await Promise.all([call("workspace_intro", { workspace_id: workspaceId }), call("workspace_info", { workspace_id: workspaceId })]);
    if (state.workspace?.id !== workspaceId || !document.contains(introduction)) return;
    const introText = string(intro.introduction) || "This workspace is ready for collaborators.";
    const participants = array(intro.participants).length; const channels = array(intro.channels).length;
    const counts = `${participants} participant${participants === 1 ? "" : "s"} · ${channels} channel${channels === 1 ? "" : "s"}`;
    const summary = introductionSummary(introText) || "This workspace is ready for collaborators.";
    introduction.replaceChildren(document.createTextNode(`${summary} `), el("span", "intro-counts", counts));
    if (summary !== introText) {
      const full = document.createElement("details"); full.className = "introduction-details";
      full.append(el("summary", "", "Read full introduction"), el("p", "", introText)); introduction.append(full);
    }
    const readmeRecord = object(intro.readme); readme.replaceChildren();
    if (readmeRecord.exists === true) {
      const ref = object(readmeRecord.ref) as ResourceRef;
      const open = button("Open README", () => {
        if (!ref.kind || ref.workspace_id !== workspaceId) return notice("The README resource is unavailable.", "error");
        renderWorkspace(); void openResource({ ref, href: string(readmeRecord.href) || canonicalHref(ref), title: string(readmeRecord.path) || "README.md", kind: ref.kind });
      }, "subtle");
      readme.append(el("p", "muted", "The workspace README is available in Artifacts."), open);
    } else readme.append(el("p", "muted", "This workspace does not have a README yet."));
    const code = joining.querySelector("code");
    const workspacePath = string(object(info.paths).workspace);
    if (code) code.textContent = string(intro.joining_prompt) || "Joining information is unavailable.";
    const pathCode = workspacePathBlock.querySelector("code"); if (pathCode) pathCode.textContent = workspacePath || "Workspace path is unavailable.";
  } catch (error) { if (state.workspace?.id === workspaceId && document.contains(introduction)) { introduction.textContent = "Workspace introduction is unavailable."; notice(message(error), "error"); } }
}

async function loadConnection(endpoint: HTMLElement, token: HTMLElement, claudeConfig?: HTMLElement, codexConfig?: HTMLElement, codexToml?: HTMLElement) {
  if (!state.workspace) return;
  try {
    const connection = await call("connection_info", { workspace_id: state.workspace.id });
    const code = (block?: HTMLElement) => block?.querySelector("code");
    const endpointCode = code(endpoint); const tokenCode = code(token);
    if (endpointCode) endpointCode.textContent = string(connection.endpoint) || "Unavailable";
    if (tokenCode) tokenCode.textContent = string(connection.token) || "Unavailable";
    const alias = `orchard-${state.workspace.id.slice(0, 8)}`;
    const url = endpointCode?.textContent || ""; const secret = tokenCode?.textContent || "";
    const claudeCode = code(claudeConfig); const codexCode = code(codexConfig); const tomlCode = code(codexToml);
    if (claudeCode) claudeCode.textContent = `claude mcp add --transport http ${alias} "${url}" --header "Authorization: Bearer ${secret}"`;
    if (codexCode) codexCode.textContent = `export ORCHARD_TOKEN="${secret}"\ncodex mcp add ${alias} --url "${url}" --bearer-token-env-var ORCHARD_TOKEN`;
    if (tomlCode) tomlCode.textContent = `[mcp_servers."${alias}"]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${secret}" }`;
  } catch (error) { notice(message(error), "error"); }
}

function refreshSnapshot(topics: string[] = ["workspace", "mail", "tasks", "artifacts", "repositories"]): Promise<void> {
  for (const topic of topics) pendingRefreshTopics.add(topic);
  if (!refreshFlight) {
    refreshFlight = (async () => {
      while (pendingRefreshTopics.size) {
        const changed = [...pendingRefreshTopics]; pendingRefreshTopics.clear();
        await refreshSnapshotNow(changed);
      }
    })().finally(() => { refreshFlight = undefined; if (pendingRefreshTopics.size) void refreshSnapshot([]); });
  }
  return refreshFlight;
}

async function refreshSnapshotNow(topics: string[]) {
  if (!state.workspace) return;
  const workspaceId = state.workspace.id;
  const generation = liveGeneration;
  const snapshot = await call("workspace_snapshot", { workspace_id: workspaceId });
  if (state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
  state.snapshot = snapshot;
  if (topics.includes("workspace") || topics.includes("plugins")) {
    try {
      const settings = await call("settings_get");
      if (state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
      state.taskBackend = object(object(settings.config).task_backend);
    } catch (error) {
      state.taskBackend = { available: false, error: message(error) };
    }
  }
  if (state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
  observeMessages(mailList("history"));
  patchConversations();
  patchOnboarding();
  const stateVisible = state.activeHref === collectionTab("states", workspaceId).href || state.activeResource?.ref.kind === "state";
  const stateOpportunityRelevant = pluginAttached("state") && (stateVisible || state.stateOpportunitiesWorkspace === workspaceId);
  if (topics.includes("state")) { await loadStateMarkers(true); if (stateOpportunityRelevant) await loadStateOpportunities(true); await refreshStateViews(workspaceId); }
  if (topics.includes("plugins") && state.screen === "settings") {
    const focused = document.activeElement as HTMLElement | null; const row = focused?.closest<HTMLElement>(".plugin-row"); const pluginName = row?.querySelector("h3")?.textContent; const action = focused?.textContent;
    const catalog = document.querySelector(".plugin-catalog"); catalog?.replaceWith(pluginCatalog());
    if (pluginName && action) [...document.querySelectorAll<HTMLElement>(".plugin-row")].find((item) => item.querySelector("h3")?.textContent === pluginName)?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { if (button.textContent === action) button.focus(); });
  }
  if (topics.includes("plugins")) {
    if (state.activeHref === collectionTab("tasks", workspaceId).href) renderTaskCollection();
    else await refreshVisibleTask(workspaceId);
    if (state.activeHref === collectionTab("states", workspaceId).href) renderStateCollection();
    else await refreshStateViews(workspaceId);
  }
  if (topics.includes("mail") && state.screen === "workspace" && state.detailView !== "form") {
    if (state.activeHref === collectionTab("agents", workspaceId).href) renderAgentCollection();
    if (state.selectedConversation && (state.activeResource && ["channel", "direct", "broadcast"].includes(state.activeResource.kind) || state.activeHref === collectionTab("directs", workspaceId).href)) await loadHistory(state.selectedConversation);
    if (state.conversationKind === "direct" && state.activeResource?.kind === "direct" && state.selectedConversation) void loadAgentContext(state.selectedConversation, state.navigationEpoch);
  }
  if (topics.includes("tasks") || topics.includes("repositories")) {
    if (topics.includes("tasks") && !topics.includes("state") && stateOpportunityRelevant) { await loadStateOpportunities(true); await refreshStateViews(workspaceId); }
    if (state.activeHref === collectionTab("tasks", workspaceId).href && state.detailView !== "form") {
      const panel = document.querySelector<HTMLElement>("#conversation"); const scroll = panel?.scrollTop || 0;
      renderTaskCollection(); if (panel) panel.scrollTop = scroll;
    } else await refreshVisibleTask(workspaceId);
  }
  if (topics.includes("artifacts") || topics.includes("repositories")) {
    const expanded = [...state.artifactExpanded];
    const roots = state.artifactRoots.map((value) => string(object(value).id));
    state.artifactRoots = []; state.artifactEntries.clear();
    if (state.treeExpanded.has("artifacts")) {
      await loadArtifactRoots();
      for (const key of expanded) {
        const rootId = roots.find((id) => key.startsWith(`${id}:`));
        if (rootId && state.workspace?.id === workspaceId) void loadArtifactDirectory(workspaceId, rootId, key.slice(rootId.length + 1));
      }
    }
    await refreshVisibleArtifact(workspaceId);
    await refreshVisibleTask(workspaceId);
  }
  if ((topics.includes("mail") || topics.includes("artifacts")) && state.activeResource && ["channel", "direct", "broadcast"].includes(state.activeResource.kind)) void loadConversationResource(state.activeResource, state.navigationEpoch);
}

async function refreshVisibleTask(workspaceId: string) {
  const active = state.activeResource;
  if (active?.ref.kind !== "task" || state.workspace?.id !== workspaceId || state.detailView === "form") return;
  const epoch = state.navigationEpoch;
  try {
    const result = await call("resource_get", { workspace_id: workspaceId, ref: active.ref });
    if (state.workspace?.id !== workspaceId || state.navigationEpoch !== epoch || state.activeHref !== active.href) return;
    state.resourceData = object(result.resource); state.resourceLinks = object(result.links);
    patchTaskDetailFromCache();
  } catch (error) { notice(message(error), "error"); }
}

async function refreshStateViews(workspaceId: string) {
  if (state.workspace?.id !== workspaceId) return;
  if (state.activeHref === collectionTab("states", workspaceId).href) { renderStateCollectionRetained(); return; }
  const active = state.activeResource;
  if (active?.ref.kind !== "state" || state.detailView === "form") return;
  const epoch = state.navigationEpoch; const panel = document.querySelector<HTMLElement>("#conversation"); if (!panel) return; const scroll = panel.scrollTop;
  if (hasSelectionWithin(panel) || (document.activeElement !== document.body && panel.contains(document.activeElement))) { statePatchPending = true; return; }
  try { const result = await call("resource_get", { workspace_id: workspaceId, ref: active.ref }); if (state.workspace?.id !== workspaceId || state.navigationEpoch !== epoch || state.activeHref !== active.href) return; state.resourceData = object(result.resource); state.resourceLinks = object(result.links); statePatchPending = false; renderResourceDetail(state.resourceData, state.resourceLinks); panel.scrollTop = scroll; }
  catch (error) { notice(message(error), "error"); }
}

function patchTaskDetailFromCache() {
  const active = state.activeResource;
  const resource = state.resourceData;
  const panel = document.querySelector<HTMLElement>("#conversation");
  if (active?.ref.kind !== "task" || !resource || !panel) { taskPatchPending = false; return; }
  const data = object(resource.data); const task = object(data.task);
  const heading = panel.querySelector<HTMLElement>(".conversation-title"); if (heading) heading.textContent = string(resource.title) || "Task";
  const context = panel.querySelector<HTMLElement>(".task-context"); if (context) context.textContent = [string(task.id) || active.ref.task_id, active.ref.store_id].filter(Boolean).join(" · ");
  const metadata = panel.querySelector<HTMLElement>(".task-metadata"); if (metadata) metadata.textContent = taskMetadata(task);
  const description = panel.querySelector<HTMLElement>(".task-description"); if (description) description.textContent = string(task.description) || string(data.description) || string(data.text) || "No task description.";
  const status = panel.querySelector<HTMLSelectElement>('select[aria-label="Task status"]');
  const writesEnabled = pluginAttached("tasks", true);
  if (status) status.disabled = !writesEnabled;
  const update = [...panel.querySelectorAll<HTMLButtonElement>(".task-controls button")].find((button) => button.textContent === "Update status"); if (update) update.disabled = !writesEnabled;
  if (!writesEnabled) panel.querySelector(".task-claim")?.remove();
  if (status && status.dataset.dirty !== "true" && document.activeElement !== status) status.value = string(task.status);
  if (taskAssignee(task) || string(task.status) !== "open") panel.querySelector(".task-claim")?.remove();
  const busyRelations = [...panel.querySelectorAll<HTMLElement>(".task-relations")].some((node) => node.contains(document.activeElement) || hasSelectionWithin(node));
  const busyLinks = [...panel.querySelectorAll<HTMLElement>(".resource-actions, .related-links")].some((node) => node.contains(document.activeElement) || hasSelectionWithin(node));
  if (!busyRelations) {
    panel.querySelectorAll(":scope > .task-relations").forEach((node) => node.remove());
    const controls = panel.querySelector(".task-controls");
    for (const section of taskRelationSections(data, task, active.ref)) controls ? panel.insertBefore(section, controls) : panel.append(section);
  }
  if (!busyLinks) {
    panel.querySelectorAll(":scope > .resource-actions, :scope > .related-links").forEach((node) => node.remove());
    appendResourceActions(panel, active, state.resourceLinks || {});
  }
  taskPatchPending = busyRelations || busyLinks || (!!status && status.dataset.dirty === "true" && !taskAssignee(task) && string(task.status) === "open" && !panel.querySelector(".task-claim"));
}

async function refreshVisibleArtifact(workspaceId: string) {
  const active = state.activeResource;
  if (active?.ref.kind !== "file" || active.ref.revision || state.workspace?.id !== workspaceId || state.detailView === "form") return;
  const panel = document.querySelector<HTMLElement>("#conversation");
  if (!panel || panel.querySelector(".inline-form")) return;
  if (hasSelectionWithin(panel) || (document.activeElement !== document.body && panel.contains(document.activeElement))) { artifactPatchPending = true; return; }
  artifactPatchPending = false;
  const epoch = state.navigationEpoch; const scroll = panel.scrollTop; const pageScroll = window.scrollY;
  try {
    const result = await call("resource_get", { workspace_id: workspaceId, ref: active.ref });
    if (state.workspace?.id !== workspaceId || state.navigationEpoch !== epoch || state.activeHref !== active.href) return;
    state.resourceData = object(result.resource); state.resourceLinks = object(result.links);
    renderResourceDetail(state.resourceData, state.resourceLinks);
    panel.scrollTop = scroll; window.scrollTo(window.scrollX, pageScroll);
  } catch (error) { notice(message(error), "error"); }
}

function patchConnectionStatus() {
  const target = document.querySelector<HTMLElement>("#connection-status");
  if (target) { target.textContent = state.connection === "connected" ? "Live" : state.connection === "connecting" ? "Connecting…" : "Disconnected · checking periodically"; target.dataset.state = state.connection; target.setAttribute("role", "status"); }
}

function stopLiveUpdates() {
  liveGeneration += 1;
  pendingRefreshTopics.clear();
  if (state.socket) { const old = state.socket; state.socket = undefined; old.close(); }
  if (state.poll) window.clearInterval(state.poll);
  if (state.reconnect) window.clearTimeout(state.reconnect);
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  state.poll = undefined; state.reconnect = undefined; state.refreshTimer = undefined;
}

function startFallback() {
  if (state.poll) return;
  state.poll = window.setInterval(() => { if (state.connection === "disconnected") void refreshSnapshot().catch((error) => notice(message(error), "error")); }, 30_000);
}

function startLiveUpdates() {
  if (!state.workspace) return;
  stopLiveUpdates();
  const workspaceId = state.workspace.id;
  const generation = liveGeneration;
  let attempt = 0;
  const connect = async () => {
    if (state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
    state.connection = "connecting"; patchConnectionStatus();
    try {
      if (!await ensureBrowserSession() || state.workspace?.id !== workspaceId || generation !== liveGeneration) throw new Error("Session unavailable");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/workspaces/${encodeURIComponent(workspaceId)}/events`);
      state.socket = socket;
      socket.addEventListener("open", () => {
        if (state.socket !== socket || generation !== liveGeneration) return;
        state.connection = "connected"; attempt = 0; patchConnectionStatus();
        if (state.poll) { window.clearInterval(state.poll); state.poll = undefined; }
      });
      socket.addEventListener("message", (event) => {
        if (state.socket !== socket || state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
        let payload: Json;
        try { payload = object(JSON.parse(String(event.data))); } catch { return; }
        if (string(payload.workspace_id) !== workspaceId) return;
        const type = string(payload.type);
        const topics = type === "changed" ? array(payload.topics).map(string) : type === "resync" ? ["workspace", "mail", "tasks", "artifacts", "repositories", "plugins", "state"] : [];
        if (type !== "changed" && type !== "hello" && type !== "resync") return;
        for (const topic of topics) pendingRefreshTopics.add(topic);
        if (!state.refreshTimer) state.refreshTimer = window.setTimeout(() => {
          state.refreshTimer = undefined;
          const changed = [...pendingRefreshTopics]; pendingRefreshTopics.clear();
          void refreshSnapshot(changed).catch((error) => notice(message(error), "error"));
        }, type === "changed" ? 80 : 0);
      });
      socket.addEventListener("close", () => {
        if (state.socket !== socket || state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
        state.socket = undefined; state.connection = "disconnected"; patchConnectionStatus(); startFallback();
        state.reconnect = window.setTimeout(() => { state.reconnect = undefined; void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)));
      });
      socket.addEventListener("error", () => socket.close());
    } catch {
      if (state.workspace?.id !== workspaceId || generation !== liveGeneration) return;
      state.connection = "disconnected"; patchConnectionStatus(); startFallback();
      state.reconnect = window.setTimeout(() => { state.reconnect = undefined; void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)));
    }
  };
  void connect();
}

void bootstrap();
