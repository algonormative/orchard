import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => { await request.post("/fixture/reset"); });

async function unlock(page: Page, create = true) {
  await page.goto("/");
  await page.getByRole("heading", { name: "Start a workspace" }).or(page.getByLabel("Workspace", { exact: true })).waitFor();
  if (create && await page.getByLabel("Workspace name").isVisible()) {
    await page.getByLabel("Workspace name").fill("Fixture workspace");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  }
  if (create) await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-1");
}

async function openTree(page: Page, name: "Chats" | "Tasks" | "Artifacts") {
  const group = page.locator("details.tree-group").filter({ has: page.locator("summary", { hasText: name }) });
  if (!(await group.evaluate((node: HTMLDetailsElement) => node.open))) await group.locator("summary").click();
  return group;
}

test("first launch is calm and exitable", async ({ page }) => {
  await unlock(page, false);
  await expect(page.getByLabel("Local access key")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Orchard", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create workspace", exact: true })).toBeVisible();
});

test("keyboard creation keeps visible labels and restores focus through Escape and Back", async ({ page }) => {
  await unlock(page, false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Orchard", exact: true })).toBeFocused();
  const create = page.getByRole("button", { name: "Create workspace", exact: true });
  await create.focus(); await page.keyboard.press("Enter");
  const name = page.getByLabel("Workspace name", { exact: true });
  const purpose = page.getByLabel("Workspace purpose (optional)", { exact: true });
  await expect(name).toBeFocused();
  await name.fill("Keyboard workspace");
  await expect(page.locator('label[for="workspace-name"]')).toBeVisible();
  await expect(page.locator('label[for="workspace-purpose"]')).toBeVisible();
  await expect(purpose).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Orchard", exact: true })).toBeFocused();

  await create.focus(); await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Orchard", exact: true })).toBeFocused();
});

test("keyboard chooser and settings navigation moves focus without leaving it on body", async ({ page }) => {
  await unlock(page);
  const allWorkspaces = page.getByRole("button", { name: "All workspaces", exact: true });
  await allWorkspaces.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#conversation")).toBeFocused();

  await allWorkspaces.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.locator("#conversation")).toBeFocused();

  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#conversation")).toBeFocused();

  await settings.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeFocused();
  await page.goBack();
  await expect(page.locator("#conversation")).toBeFocused();

  const composer = page.getByLabel("Message");
  await composer.focus();
  await settings.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
});

test("Settings return paths preserve a reply draft and its original thread target", async ({ page }) => {
  await unlock(page);
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  const originalMessage = page.locator(".message").filter({ hasText: "General fixture message" });
  const composer = page.getByLabel("Message");

  await originalMessage.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(composer).toHaveAttribute("placeholder", "Write a reply");
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await expect(composer).toHaveAttribute("placeholder", "Write a message");

  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await originalMessage.getByRole("button", { name: "Reply", exact: true }).click();
  await composer.fill("Reply survives every Settings return path");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).first().click();
  await expect(composer).toHaveValue("Reply survives every Settings return path");
  await expect(composer).toHaveAttribute("placeholder", "Write a reply");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(composer).toHaveValue("Reply survives every Settings return path");
  await expect(composer).toHaveAttribute("placeholder", "Write a reply");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.goBack();
  await expect(composer).toHaveValue("Reply survives every Settings return path");
  await expect(composer).toHaveAttribute("placeholder", "Write a reply");

  const sent = page.waitForResponse((response) => response.url().endsWith("/api/call") && response.request().postDataJSON().operation === "mail_send");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const payload = (await sent).request().postDataJSON();
  expect(payload.args).toEqual(expect.objectContaining({ body: "Reply survives every Settings return path", thread_id: "general-1" }));
});

test("background refresh does not steal a focused workspace draft", async ({ page, request }) => {
  await unlock(page);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  const name = page.getByLabel("Workspace name", { exact: true });
  await name.fill("Draft that stays focused");
  await request.post("/fixture/external-change", { data: { message: "Background update", topics: ["mail"] } });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Draft that stays focused");
});

test("collection routes load directly and survive reload", async ({ page }) => {
  await unlock(page);
  for (const [route, title] of [["~tasks", "Tasks"], ["~agents", "Agents"], ["~directs", "All direct messages"]]) {
    await page.goto(`/w/workspace-1/${route}`);
    await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
  }
});

test("preview tabs reuse, keep on interaction or double click, reorder and close groups", async ({ page }) => {
  await unlock(page);
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.locator('.tab-item[data-preview="true"]')).toHaveCount(1);
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await expect(page.getByRole("tab", { name: "#general", exact: true })).toHaveCount(0);
  await page.getByLabel("Message").fill("An unsent draft");
  await expect(page.locator('.tab-item[data-preview="true"]')).toHaveCount(0);
  await chats.getByRole("button", { name: "#general", exact: true }).dblclick();
  await expect(page.locator('.tab-item[data-preview="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Tab options for #general" }).click();
  await page.getByRole("menuitem", { name: "Move Left" }).click();
  await expect(page.getByRole("tab").first()).toHaveText("#general");
  await page.getByRole("button", { name: "Tab options for #general" }).click();
  await page.getByRole("menuitem", { name: "Close Others" }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await expect(page.getByLabel("Message")).toHaveValue("An unsent draft");
});

test("tab button double click keeps preview and menu close history stays in sync", async ({ page }) => {
  await unlock(page);
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByRole("tab", { name: "#general", exact: true }).dblclick();
  await expect(page.locator('.tab-item[data-preview="true"]')).toHaveCount(0);
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await page.getByRole("button", { name: "Tab options for @Alice" }).click();
  await page.getByRole("menuitem", { name: "Close Others" }).click();
  await expect(page.getByRole("tab", { name: "@Alice", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/direct\/alice$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/channels\/general$/);
  await expect(page.getByRole("tab", { name: "#general", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#thread")).toContainText("General fixture message");
  await page.getByRole("button", { name: "Tab options for #general" }).click();
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("Choose a resource");
  await page.goBack();
  await expect(page).toHaveURL(/\/channels\/general$/);
  await expect(page.getByRole("tab", { name: "#general", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("agent and direct permalinks share one owner conversation", async ({ page }) => {
  await unlock(page);
  await page.goto("/w/workspace-1/agents/alice");
  await expect(page.getByRole("tab", { name: "@Alice", exact: true })).toHaveCount(1);
  await expect(page.locator(".agent-context")).toContainText("Last contact");
  await expect(page.locator("#thread")).toContainText("Owner to Alice");
  await expect(page.locator("#thread")).not.toContainText("Agent to agent");
  await page.goto("/w/workspace-1/direct/alice");
  await expect(page.getByRole("tab", { name: "@Alice", exact: true })).toHaveCount(1);
  await expect(page.locator(".agent-context")).toContainText("Registered");
});

test("live event refreshes a visible task and chat without touching draft", async ({ page, request }) => {
  await unlock(page);
  await expect(page.locator("#connection-status")).toHaveAttribute("data-state", "connected");
  await page.getByLabel("Message").fill("Keep this draft");
  await request.post("/fixture/external-change", { data: { message: "External live message", topics: ["mail"] } });
  await expect(page.locator("#thread")).toContainText("External live message");
  await expect(page.getByLabel("Message")).toHaveValue("Keep this draft");
  await openTree(page, "Tasks"); await page.getByRole("button", { name: "Fixture task", exact: true }).first().click();
  await request.post("/fixture/external-change", { data: { task_status: "blocked", topics: ["tasks"] } });
  await expect(page.locator(".task-metadata")).toContainText("Blocked");
});

test("needs-you decisions can be replied to or marked decided", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/external-change", { data: { mail_message: { id: "decision-direct", sender_id: "alice", destination: { kind: "direct", id: "owner" }, body: "Choose the release window", kind: "decision" }, topics: ["mail"] } });
  const needsYou = page.locator('#needs-you[aria-label="Needs you"]');
  await expect(needsYou).toContainText("@Alice");
  await expect(needsYou).toContainText("Choose the release window");
  await needsYou.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("tab", { name: "@Alice", exact: true })).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveAttribute("placeholder", "Write a reply");
  await needsYou.getByRole("button", { name: "Mark decided", exact: true }).click();
  await expect(needsYou).toBeHidden();
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.messages).toContainEqual(expect.objectContaining({ sender_id: "owner", destination: { kind: "direct", id: "alice" }, body: "Decided.", kind: "message", thread_id: "decision-direct" }));
});

test("a decision arriving mid-draft keeps the draft and its focus", async ({ page, request }) => {
  await unlock(page);
  const composer = page.getByLabel("Message");
  await composer.fill("Half-written thought");
  await composer.focus();
  await request.post("/fixture/external-change", { data: { mail_message: { id: "decision-midway", sender_id: "alice", destination: { kind: "channel", id: "general" }, body: "Ship today?", kind: "decision" }, topics: ["mail"] } });
  await expect(page.locator('#needs-you[aria-label="Needs you"]')).toContainText("Ship today?");
  await expect(composer).toHaveValue("Half-written thought");
  await expect(composer).toBeFocused();
});

test("needs-you shows a decision older than the loaded history window", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/external-change", { data: { mail_message: { id: "decision-buried", sender_id: "alice", destination: { kind: "direct", id: "owner" }, body: "Buried question", kind: "decision" }, topics: ["mail"] } });
  for (let index = 0; index < 60; index += 1) await request.post("/fixture/external-change", { data: { message: `noise ${index}` } });
  await request.post("/fixture/external-change", { data: { message: "last noise", topics: ["mail"] } });
  await expect(page.locator('#needs-you[aria-label="Needs you"]')).toContainText("Buried question");
});

test("needs-you ignores ordinary and already-resolved decisions", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/external-change", { data: { mail_message: { id: "ordinary-message", sender_id: "alice", destination: { kind: "channel", id: "general" }, body: "Not a decision", kind: "message" }, topics: ["mail"] } });
  await request.post("/fixture/external-change", { data: { mail_message: { id: "resolved-decision", sender_id: "alice", destination: { kind: "broadcast" }, body: "Already resolved", kind: "decision" }, topics: ["mail"] } });
  await request.post("/fixture/external-change", { data: { mail_message: { id: "resolved-reply", sender_id: "owner", destination: { kind: "broadcast" }, body: "Decided.", kind: "message", thread_id: "resolved-decision" }, topics: ["mail"] } });
  await expect(page.locator('#needs-you[aria-label="Needs you"]')).toBeHidden();
});

test("repository rows show available git status", async ({ page, request }) => {
  await unlock(page);
  const tasks = await openTree(page, "Tasks");
  await tasks.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByLabel("Project path").fill("/private/tmp/example-project");
  await page.getByRole("button", { name: "Add project", exact: true }).last().click();
  await request.post("/fixture/external-change", { data: { repository_git: { branch: "feature/needs-you", dirty: 3 }, topics: ["repositories"] } });
  const status = tasks.locator(".repository-git-status");
  await expect(status).toContainText("feature/needs-you · 3 changed");
  await request.post("/fixture/external-change", { data: { repository_git: { branch: null, dirty: 0 }, topics: ["repositories"] } });
  await expect(status).toContainText("detached");
  await request.post("/fixture/external-change", { data: { repository_git: { available: false }, topics: ["repositories"] } });
  await expect(status).toHaveCount(0);
});

test("a newer build after reconnect offers a calm manual reload", async ({ page, request }) => {
  await unlock(page);
  await expect(page.locator("#connection-status")).toHaveAttribute("data-state", "connected");
  await request.post("/fixture/build", { data: { app_version: "0.2.1", server_version: "0.1.0", ui_hash: "a".repeat(64) } });
  await request.post("/fixture/drop-events");
  const update = page.locator("#build-update-notice");
  await expect(update).toContainText("Orchard was updated.");
  await expect(update.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
});

test("an unchanged or malformed build after reconnect stays quiet", async ({ page, request }) => {
  await unlock(page);
  await expect(page.locator("#build-update-notice")).toBeHidden();
  await expect(page.locator("#connection-status")).toHaveAttribute("data-state", "connected");
  // Each reconnect re-reads /api/build; wait for that read rather than a fixed delay.
  const rechecked = () => page.waitForResponse((response) => response.url().endsWith("/api/build"));
  let check = rechecked(); await request.post("/fixture/drop-events"); await check;
  await expect(page.locator("#build-update-notice")).toBeHidden();
  await request.post("/fixture/build", { data: {} });
  check = rechecked(); await request.post("/fixture/drop-events"); await check;
  await expect(page.locator("#build-update-notice")).toBeHidden();
});

test("a newer-build notice leaves a composer draft intact until Reload", async ({ page, request }) => {
  await unlock(page);
  const composer = page.getByLabel("Message"); await composer.fill("Keep this draft until I choose reload");
  await request.post("/fixture/build", { data: { app_version: "0.2.1", server_version: "0.1.0", ui_hash: "b".repeat(64) } });
  await request.post("/fixture/drop-events");
  const update = page.locator("#build-update-notice");
  await expect(update).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft until I choose reload");
  const navigated = page.waitForEvent("framenavigated");
  await update.getByRole("button", { name: "Reload", exact: true }).click();
  await navigated;
});

test("Settings return restores live connection status and an existing build-update notice", async ({ page, request }) => {
  await unlock(page);
  const connection = page.locator("#connection-status");
  const update = page.locator("#build-update-notice");
  await expect(connection).toHaveAttribute("data-state", "connected");
  await expect(connection).toHaveText("Live");
  await request.post("/fixture/build", { data: { app_version: "0.2.1", server_version: "0.1.0", ui_hash: "c".repeat(64) } });
  await request.post("/fixture/drop-events");
  await expect(update).toBeVisible();
  await expect(connection).toHaveAttribute("data-state", "connected");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).first().click();
  await expect(connection).toHaveAttribute("data-state", "connected");
  await expect(connection).toHaveText("Live");
  await expect(update).toBeVisible();
  await expect(update).toContainText("Orchard was updated.");
});

test("assigned in-progress work appears under its direct participant and opens its task tab", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/external-change", { data: { task_assignee: "alice", task_status: "in_progress", topics: ["tasks"] } });
  const chats = await openTree(page, "Chats");
  const assigned = chats.getByRole("button", { name: "fixture-1 Fixture task", exact: true });
  await expect(assigned).toBeVisible();
  await assigned.click();
  await expect(page.getByRole("tab", { name: "Fixture task", exact: true })).toBeVisible();
  await expect(page.locator(".task-metadata")).toContainText("In progress");
});

test("detached Tasks does not add assigned work beneath direct participants", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/external-change", { data: { task_assignee: "alice", task_status: "in_progress", topics: ["tasks"] } });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".plugin-row", { hasText: "Tasks" }).getByRole("button", { name: "Detach" }).click();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).first().click();
  const chats = await openTree(page, "Chats");
  await expect(chats.getByRole("button", { name: "fixture-1 Fixture task", exact: true })).toHaveCount(0);
});

test("overlapping live topics drain after delayed snapshots and ongoing events do not starve", async ({ page, request }) => {
  await unlock(page);
  await expect(page.locator("#connection-status")).toHaveAttribute("data-state", "connected");
  await openTree(page, "Artifacts");
  await page.getByRole("button", { name: /Fixture artifacts/ }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await request.post("/fixture/delay", { data: { snapshot: 220 } });
  await request.post("/fixture/external-change", { data: { message: "Overlapping mail", topics: ["mail"] } });
  await page.waitForTimeout(110);
  await request.post("/fixture/external-change", { data: { file_text: "# Refreshed artifact", topics: ["artifacts"] } });
  await expect(page.locator("#conversation")).toContainText("Refreshed artifact");
  await request.post("/fixture/delay", { data: {} });
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.locator("#thread")).toContainText("Overlapping mail");
  const stream = (async () => { for (let index = 0; index < 14; index += 1) { await request.post("/fixture/external-change", { data: { message: `stream-${index}`, topics: ["mail"] } }); await new Promise((resolve) => setTimeout(resolve, 50)); } })();
  await expect(page.locator("#thread")).toContainText("stream-0", { timeout: 450 });
  await stream;
});

test("global tree opens chats, task defaults, artifacts, and tabs", async ({ page }) => {
  await unlock(page);
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.locator("#thread").getByRole("link", { name: "https://example.com/docs", exact: true })).toHaveAttribute("rel", "noreferrer");
  await expect(page.locator("#thread").getByRole("link", { name: "/w/workspace-1/files/fixture-root?path=README.md", exact: true })).toBeVisible();
  await expect(page.locator("#thread code a")).toHaveCount(0);
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await expect(page.locator("#thread")).toContainText("Owner to Alice");
  await expect(page.locator("#thread")).not.toContainText("Agent to agent");
  await openTree(page, "Tasks");
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("Workspace tasks");
  await page.getByRole("button", { name: "Fixture task", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "Fixture task", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tab options for Fixture task" }).click();
  await page.getByRole("menuitem", { name: "Keep Open" }).click();
  await openTree(page, "Artifacts");
  await page.getByRole("button", { name: /Fixture artifacts/ }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close README.md", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Fixture task", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("file viewer renders markdown, code, image, safe relative links, and pinned history", async ({ page }) => {
  await unlock(page); await openTree(page, "Artifacts");
  await page.getByRole("button", { name: /Fixture artifacts/ }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  const viewer = page.locator("#conversation");
  await expect(viewer.getByRole("heading", { name: "Fixture heading" })).toBeVisible();
  await expect(viewer.locator(".code-block code")).toHaveText("console.log('fixture')");
  await expect(viewer.getByRole("button", { name: "Code", exact: true })).toBeVisible();
  await expect(viewer).toContainText("Outside");
  await expect(viewer.getByRole("button", { name: "Outside", exact: true })).toHaveCount(0);
  await viewer.getByText("Versions", { exact: true }).click();
  await viewer.getByRole("button", { name: /0123456789 Fixture version/ }).click();
  await expect(page).toHaveURL(/revision=0123456789abcdef0123456789abcdef01234567/);
  await viewer.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page).toHaveURL(/path=docs%2Fexample.py&revision=0123456789abcdef0123456789abcdef01234567/);
  await expect(viewer.locator(".code-block code")).toHaveText("print('fixture')");
  await page.getByRole("button", { name: "image.png", exact: true }).click();
  await expect(viewer.getByRole("img", { name: "image.png" })).toHaveAttribute("src", "/fixture/image.png");
  await expect(viewer).not.toContainText("null");
});

test("typed attachments and resource links produce navigable backlinks", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { attach: 300 } }); await request.post("/fixture/fail-upload-once"); await openTree(page, "Artifacts");
  await page.getByRole("button", { name: /Fixture artifacts/ }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link resource").fill("/w/workspace-1/files/fixture-root?path=docs%2Fexample.py");
  await page.locator("form.inline-form").getByRole("button", { name: "Add link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Links", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "docs/example.py", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Backlinks", exact: true })).toBeVisible();
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: /^#general/ }).click();
  await page.getByLabel("Message").fill("Typed attachment");
  const failedUpload = page.waitForResponse((response) => response.url().endsWith("/api/call") && response.request().postDataJSON().operation === "artifact_upload");
  await page.locator('input[type="file"]').setInputFiles({ name: "message-note.txt", mimeType: "text/plain", buffer: Buffer.from("fixture attachment\n") });
  expect((await failedUpload).status()).toBe(503);
  await expect(page.locator(".attachment-chip")).toContainText("Upload failed");
  const uploaded = page.waitForResponse((response) => response.url().endsWith("/api/call") && response.request().postDataJSON().operation === "artifact_upload");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await openTree(page, "Tasks"); await page.getByRole("button", { name: "All tasks", exact: true }).click();
  expect((await uploaded).ok()).toBeTruthy();
  await page.getByRole("tab", { name: "#general", exact: true }).click();
  await expect(page.locator(".attachment-chip")).toContainText("message-note.txt");
  await expect(page.getByRole("button", { name: "Remove attachment message-note.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const audit = await (await request.get("/fixture/audit")).json();
  const sent = audit.calls.filter((entry: { operation: string }) => entry.operation === "mail_send").at(-1);
  expect(sent.args.refs).toEqual([{ type: "resource", resource: { kind: "file", workspace_id: "workspace-1", root_id: "fixture-root", path: "message-note.txt", revision: "0123456789abcdef0123456789abcdef01234567" } }]);
  await expect(page.locator("#thread").getByRole("button", { name: "message-note.txt", exact: true })).toBeVisible();
});

test("deep permalink opens directly and survives second-workspace switching", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/revoke");
  await page.goto("/w/workspace-1/files/fixture-root?path=README.md");
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/w\/workspace-1\/files\/fixture-root\?path=README.md$/);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Second workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-2");
  await expect(page).toHaveURL(/\/w\/workspace-2\/channels\/general$/);
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveCount(0);
  await page.getByLabel("Workspace", { exact: true }).selectOption("workspace-1");
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-1");
  await expect(page).toHaveURL(/\/w\/workspace-1\/channels\/general$/);
  await expect(page.locator("#thread")).toContainText("General fixture message");
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveCount(0);
  await expect(page.locator("#conversation")).not.toContainText("Second workspace");
});

test("all workspaces chooser supports back and reload without an access key", async ({ page, request }) => {
  await unlock(page);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Second workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByLabel("Message").fill("Draft stays local");

  await page.getByRole("button", { name: "All workspaces", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Second workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fixture workspace", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Message")).toHaveValue("Draft stays local");

  await page.getByRole("button", { name: "All workspaces", exact: true }).click();
  await page.getByRole("button", { name: "Fixture workspace", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/workspace-1\/channels\/general$/);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "All Workspaces", exact: true })).toBeVisible();
  await expect(page.getByLabel("Local access key")).toHaveCount(0);
  await page.getByRole("button", { name: "Fixture workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-1");
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.some((entry: { operation: string; args: { workspace_id?: string } }) => entry.operation === "workspace_visit" && entry.args.workspace_id === "workspace-1")).toBeTruthy();
});

test("workspace settings has a canonical reloadable route and opens README in the viewer", async ({ page, request }) => {
  await unlock(page);
  const build = await request.get("/api/build");
  expect(build.status()).toBe(200);
  expect(build.headers()["cache-control"]).toBe("no-cache");
  expect(build.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await build.json()).toEqual({ app_version: "0.2.0", server_version: "0.1.0", ui_hash: "f".repeat(64) });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/workspace-1\/settings$/);
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
  await expect(page.getByText(/2 participants · 2 channels/)).toBeVisible();
  await expect(page.locator(".settings-section .code-block code").first()).toContainText("workspace workspace-1");
  await expect(page.locator(".settings-section .code-block code").nth(1)).toContainText("/private/tmp/orchard-fixture-workspaces/workspace-1");
  await expect(page.locator(".build-identity .code-block code")).toContainText("App version: 0.2.0");
  await expect(page.locator(".build-identity .code-block code")).toContainText("Revision: unavailable");
  await request.post("/fixture/revoke"); await page.reload();
  await expect(page).toHaveURL(/\/w\/workspace-1\/settings$/);
  await page.getByRole("button", { name: "Open README", exact: true }).click();
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
});

test("plugin settings detach Tasks and live State remains a readable canonical resource", async ({ page, request }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".plugin-catalog")).toContainText("Core");
  await expect(page.locator(".plugin-catalog")).toContainText("Tasks");
  await page.locator(".plugin-row", { hasText: "Tasks" }).getByRole("button", { name: "Detach" }).click();
  await expect(page.locator(".plugin-row", { hasText: "Tasks" })).toContainText("Detached");
  await page.locator(".plugin-row", { hasText: "Tasks" }).getByRole("button", { name: "View retained data" }).click();
  await expect(page.locator("#conversation")).toContainText("Preserved task records are read-only.");
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeDisabled();
  await expect(page.locator("#conversation")).toContainText("Fixture task");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).first().click();
  await expect(page.locator("details.tree-group").filter({ hasText: "Tasks" })).toHaveCount(0);
  await page.goto("/w/workspace-1/~states");
  await expect(page.getByRole("tab", { name: "State", exact: true })).toBeVisible();
  await page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ }).click();
  await expect(page).toHaveURL(/\/w\/workspace-1\/states\/marker-1$/);
  await expect(page.locator("#conversation")).toContainText("History");
  await expect(page.locator("#conversation")).toContainText("Definition Release · v1");
  await request.post("/fixture/external-change", { data: { marker_state: "review", topics: ["state"] } });
  await expect(page.locator("#conversation")).toContainText("State: review · revision 2");
});

test("Roles settings create, fill, edit, delete, and detach roles", async ({ page, request }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const roles = page.locator("#roles-settings-section");
  await expect(roles).toContainText(/self-declared and advisory/i);

  await roles.getByRole("button", { name: "Create role", exact: true }).click();
  const editor = roles.locator(".role-editor");
  const label = editor.getByLabel("Role label", { exact: true });
  await label.fill("Release coordinator");
  await expect(editor.getByLabel("Role id", { exact: true })).toHaveValue("release-coordinator");
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/call") && response.request().postDataJSON().operation === "workspace_snapshot");
  await request.post("/fixture/role-declaration", { data: { participant_id: "alice", roles: ["reviewer"], skills: ["playwright"] } });
  await refreshed;
  await expect(label).toBeFocused();
  await expect(label).toHaveValue("Release coordinator");
  await editor.getByLabel("Needed", { exact: true }).fill("1");
  await editor.getByLabel("Capabilities (comma-separated)", { exact: true }).fill("handoff, review");
  await editor.getByLabel("Instructions", { exact: true }).fill("Coordinate the release handoff.");
  await editor.getByRole("button", { name: "Save role", exact: true }).click();

  const role = roles.locator('.role-row[data-role-id="release-coordinator"]');
  await expect(role).toContainText("Open 0 of 1");
  await expect(role).toContainText("Coordinate the release handoff.");
  await request.post("/fixture/role-declaration", { data: { participant_id: "alice", roles: ["release-coordinator"], skills: ["release-testing"] } });
  await expect(role).toContainText("Filled 1 of 1");
  await expect(role).toContainText("@Alice");

  await role.getByRole("button", { name: "Edit", exact: true }).click();
  await editor.getByLabel("Role label", { exact: true }).fill("Release lead");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(role).toContainText("Release lead");

  await role.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(role).toContainText("Delete this role?");
  await role.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(role).toHaveCount(0);
  await roles.getByRole("button", { name: "Create role", exact: true }).click();
  await editor.getByLabel("Role label", { exact: true }).fill("Advisory observer");
  await editor.getByLabel("Needed", { exact: true }).fill("0");
  await editor.getByLabel("Instructions", { exact: true }).fill("Observe without a staffing requirement.");
  await editor.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(roles.locator('.role-row[data-role-id="advisory-observer"]')).toContainText("descriptive");
  await page.locator(".plugin-row", { hasText: "Roles" }).getByRole("button", { name: "Detach", exact: true }).click();
  await expect(roles).toHaveCount(0);
});

test("Roles editor escapes, reports host validation, and cancels visibly", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const roles = page.locator("#roles-settings-section");

  await roles.getByRole("button", { name: "Create role", exact: true }).click();
  const editor = roles.locator(".role-editor");
  await editor.getByLabel("Role label", { exact: true }).fill("Draft that closes");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);

  await roles.getByRole("button", { name: "Create role", exact: true }).click();
  await editor.getByLabel("Role label", { exact: true }).fill("Invalid role");
  await editor.getByLabel("Role id", { exact: true }).fill("-bad");
  await editor.getByLabel("Instructions", { exact: true }).fill("This reaches fixture validation.");
  await editor.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(editor.locator(".roles-form-error")).toContainText("role.id must be a 1..64 character lowercase role id");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveCount(0);
});

test("direct identity shows self-declared Roles and skills", async ({ page, request }) => {
  await request.post("/fixture/role-declaration", { data: { participant_id: "alice", roles: ["reviewer"], skills: ["playwright", "triage"] } });
  await unlock(page);
  await page.goto("/w/workspace-1/direct/alice");
  const identity = page.locator(".agent-context");
  await expect(identity).toContainText("self-declared roles: reviewer");
  await expect(identity).toContainText("skills: playwright, triage");
});

test("State collection loads an empty list once and scopes cached markers to its workspace", async ({ page, request }) => {
  await unlock(page);
  await openTree(page, "Tasks");
  const stateTree = page.locator("details.tree-group").filter({ has: page.locator("summary", { hasText: "State" }) });
  if (!(await stateTree.evaluate((node: HTMLDetailsElement) => node.open))) await stateTree.locator("summary").click();
  await stateTree.getByRole("button", { name: "All state markers", exact: true }).click();
  await expect(page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ })).toBeVisible();
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.filter((entry: { operation: string }) => entry.operation === "state_list")).toHaveLength(1);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("State switch");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.goto("/w/workspace-2/~states");
  await expect(page.getByRole("button", { name: /Fixture release/ })).toHaveCount(0);
});

test("State event during an older marker list drains to a fresh tree and collection", async ({ page, request }) => {
  await request.post("/fixture/delay", { data: { state_list: 250 } });
  await unlock(page);
  await request.post("/fixture/external-change", { data: { marker_state: "review", topics: ["state"] } });
  const stateTree = page.locator("details.tree-group").filter({ has: page.locator("summary", { hasText: "State" }) });
  await expect(stateTree.getByRole("button", { name: /Fixture release.*review/ })).toBeVisible();
  await stateTree.getByRole("button", { name: "All state markers", exact: true }).click();
  await expect(page.locator("#conversation").getByRole("button", { name: /Fixture release.*review/ })).toBeVisible();
});

test("a failed State list is shown once without an immediate retry loop", async ({ page, request }) => {
  await request.post("/fixture/fail-state-list");
  await unlock(page);
  const stateTree = page.locator("details.tree-group").filter({ has: page.locator("summary", { hasText: "State" }) });
  await expect(stateTree).toContainText("State is unavailable: Fixture State store is unavailable");
  await expect(stateTree).not.toContainText("No state markers yet.");
  await page.waitForTimeout(300);
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.filter((entry: { operation: string }) => entry.operation === "state_list")).toHaveLength(1);
});

test("State guidance and work opportunities show honest readiness and refresh with task changes", async ({ page, request }) => {
  await unlock(page);
  await page.goto("/w/workspace-1/~states");
  await page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ }).click();
  await expect(page.locator("#conversation")).toContainText("Guidance");
  await expect(page.locator("#conversation")).toContainText("Collect the release evidence before advancing.");
  await expect(page.locator("#conversation")).toContainText("Relevant capabilities: release-review");
  await expect(page.locator("#conversation")).toContainText("Observed task");
  await expect(page.locator("#conversation")).toContainText("Needs input");
  await expect(page.locator("#conversation")).toContainText("Attach the release checklist.");
  await expect(page.locator("#conversation")).toContainText("File reference required");
  await page.goto("/w/workspace-1/~states");
  await page.getByRole("button", { name: "Work opportunities", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("Collect the release evidence before advancing.");
  await expect(page.locator("#conversation")).toContainText("Attach the release checklist.");
  await request.post("/fixture/external-change", { data: { marker_state: "review", task_status: "closed", topics: ["tasks"] } });
  await expect(page.locator("#conversation")).toContainText("1 ready");
  await page.locator("#conversation").getByRole("button", { name: /Fixture release.*review/ }).click();
  await expect(page.locator("#conversation")).toContainText("Subject task closed");
});

test("State map shows branches, cycles, self-loops, and current initial terminal markers", async ({ page, request }) => {
  await request.post("/fixture/state-definition", { data: { definition: { id: "release", version: "2", label: "Release", states: ["draft", "review", "blocked", "shipped", "orphan"], initial: "draft", transitions: [{ from: "draft", to: "review", label: "submit" }, { from: "draft", to: "blocked", label: "hold" }, { from: "review", to: "draft", label: "revise" }, { from: "blocked", to: "blocked", label: "wait" }, { from: "review", to: "shipped", label: "ship" }] } } });
  await unlock(page); await page.goto("/w/workspace-1/~states"); await page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ }).click();
  const map = page.locator(".state-diagram"); await expect(map).toContainText("State map"); await expect(map.locator("svg.state-diagram-graph")).toHaveAttribute("role", "img"); await expect(map.locator(".state-diagram-edge")).toHaveCount(5); await expect(map.locator(".state-diagram-node.is-current")).toContainText("draft"); await expect(map.locator(".state-diagram-node").filter({ hasText: "draft" })).toContainText("initial"); await expect(map.locator(".state-diagram-node").filter({ hasText: "shipped" })).toContainText("terminal"); await expect(map.locator(".state-diagram-node").filter({ hasText: "orphan" })).toContainText("terminal");
});

test("State map treats hostile text as text and confines long labels on mobile", async ({ page, request }) => {
  const hostile = "<img src=x onerror=alert(1)>"; const long = "界".repeat(40);
  await request.post("/fixture/state-definition", { data: { definition: { states: ["draft", long], initial: "draft", transitions: [{ from: "draft", to: long, label: hostile }] } } });
  await unlock(page); await page.setViewportSize({ width: 375, height: 720 }); await page.goto("/w/workspace-1/~states"); await page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ }).click();
  const map = page.locator(".state-diagram"); const edgeLabel = map.locator(".state-diagram-edge-label"); await expect(map.locator("img")).toHaveCount(0); await expect(edgeLabel.locator("title")).toContainText(hostile); expect(await edgeLabel.evaluate((node) => node.firstChild?.textContent)).toBe(`${hostile.slice(0, 17)}…`); expect(await map.locator(".state-diagram-scroll").evaluate((node) => node.scrollWidth > node.clientWidth)).toBeTruthy();
});

test("State map updates the current highlight and retains its focused scroll position", async ({ page, request }) => {
  const states = Array.from({ length: 8 }, (_, index) => `state-${index}`); const transitions = states.slice(0, -1).map((from, index) => ({ from, to: states[index + 1], label: `to ${index + 1}` }));
  await request.post("/fixture/state-definition", { data: { definition: { states, initial: "state-0", transitions } } });
  await unlock(page); await page.goto("/w/workspace-1/~states"); await page.locator("#conversation").getByRole("button", { name: /Fixture release.*draft/ }).click();
  const scroll = page.locator(".state-diagram-scroll"); await scroll.evaluate((node: HTMLElement) => { node.scrollLeft = 280; node.scrollTop = 12; node.focus(); }); await request.post("/fixture/external-change", { data: { marker_state: "state-3", topics: ["state"] } });
  await expect(page.locator(".state-diagram-node.is-current")).toContainText("state-3"); expect(await scroll.evaluate((node: HTMLElement) => ({ left: node.scrollLeft, focused: document.activeElement === node }))).toEqual({ left: 280, focused: true });
});

test("work opportunities have an empty and retryable error state", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/fail-state-opportunities");
  await page.goto("/w/workspace-1/~states");
  await page.getByRole("button", { name: "Work opportunities", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("Work opportunities are unavailable: Fixture opportunities are unavailable");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("Fixture release");
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Empty opportunities");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.goto("/w/workspace-2/~states");
  await page.getByRole("button", { name: "Work opportunities", exact: true }).click();
  await expect(page.locator("#conversation")).toContainText("No work opportunities right now.");
});

test("thread scroll position survives a Settings round trip", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/long-history"); await page.reload();
  await page.locator(".message").nth(30).waitFor();
  const thread = page.locator("#thread");
  await thread.evaluate((node) => { node.scrollTop = 300; });
  const before = await thread.evaluate((node) => node.scrollTop);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to workspace" }).first().click();
  await page.locator(".message").nth(30).waitFor();
  await expect.poll(() => thread.evaluate((node) => node.scrollTop)).toBeGreaterThan(before - 32);
  expect(await thread.evaluate((node) => node.scrollTop)).toBeLessThan(before + 32);
});

test("draft, reply, scroll, reconnect, and polling preserve working context", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/long-history");
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const composer = page.getByLabel("Message"); await composer.fill("Draft survives reconnect and poll");
  await page.locator("#thread").evaluate((thread) => { thread.scrollTop = 120; });
  await openTree(page, "Artifacts"); await page.getByRole("button", { name: /Fixture artifacts/ }).click();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await page.waitForTimeout(8_500);
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.goBack();
  await page.getByRole("tab", { name: /# general|general/i }).click();
  await expect(composer).toHaveValue("Draft survives reconnect and poll");
  await request.post("/fixture/revoke"); await page.waitForTimeout(8_500);
  await expect(composer).toHaveValue("Draft survives reconnect and poll");
  await expect.poll(() => page.locator("#thread").evaluate((thread) => thread.scrollTop)).toBeGreaterThan(0);
  const tabs = page.getByRole("tab");
  while (await tabs.count()) await page.getByRole("button", { name: /^Close / }).last().click();
  await expect(page.locator("#conversation")).toContainText("Choose a resource");
});

test("pending operations preserve newer input and do not reopen stale views", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { send: 300, attach: 300, action: 300 } });
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  const composer = page.getByLabel("Message"); await composer.fill("First submission");
  await page.getByRole("button", { name: "Send", exact: true }).click(); await composer.fill("Newer unsent text");
  await page.waitForTimeout(450); await expect(composer).toHaveValue("Newer unsent text");
  await openTree(page, "Tasks"); await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.getByLabel("Project path").fill("/private/tmp/example-project");
  await page.getByRole("button", { name: "Add project", exact: true }).last().click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click(); await page.waitForTimeout(450);
  await expect(page.getByLabel("Project path")).toHaveCount(0);
  await page.getByRole("button", { name: "Fixture task", exact: true }).first().click();
  await page.getByLabel("Task status").selectOption("in_progress"); await page.getByRole("button", { name: "Update status" }).click();
  await page.getByRole("tab", { name: /general/i }).click(); await page.waitForTimeout(450);
  await expect(page.locator("#thread")).toBeVisible();
});

test("mail retry reuses the accepted request after its response is lost", async ({ page, request }) => {
  await unlock(page);
  await request.post("/fixture/lose-mail-response-once");
  const chats = await openTree(page, "Chats");
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByLabel("Message").fill("Only one copy");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toBeVisible();
  await page.getByRole("button", { name: "Retry original message", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toHaveCount(0);
  const audit = await (await request.get("/fixture/audit")).json();
  const attempts = audit.calls.filter((entry: { operation: string; args: { body?: string } }) => entry.operation === "mail_send" && entry.args.body === "Only one copy");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].args.request_id).toBe(attempts[1].args.request_id);
  expect(audit.messages.filter((entry: { body?: string }) => entry.body === "Only one copy")).toHaveLength(1);
});

test("uncertain mail retains original payload while newer draft and navigation change", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/lose-mail-response-once");
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  const composer = page.getByLabel("Message"); await composer.fill("Original body");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toBeVisible();
  await composer.fill("Edited body stays");
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await chats.getByRole("button", { name: /^#general/ }).click();
  await expect(composer).toHaveValue("Edited body stays");
  await page.getByRole("button", { name: "Retry original message", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toHaveCount(0);
  await expect(composer).toHaveValue("Edited body stays");
  const audit = await (await request.get("/fixture/audit")).json();
  const attempts = audit.calls.filter((entry: { operation: string; args: { body?: string } }) => entry.operation === "mail_send" && entry.args.body === "Original body");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].args).toEqual(attempts[1].args);
  expect(audit.messages.filter((entry: { body?: string }) => entry.body === "Original body")).toHaveLength(1);
  expect(audit.messages.some((entry: { body?: string }) => entry.body === "Edited body stays")).toBeFalsy();
});

test("late mail confirmation from another workspace keeps the new workspace draft", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { send: 1000 } });
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByLabel("Message").fill("Old workspace message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Second workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-2");
  await page.getByLabel("Message").fill("Old workspace message");
  await page.waitForTimeout(1250);
  await expect(page.getByLabel("Message")).toHaveValue("Old workspace message");
});

test("late failed mail stays with its original workspace", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { send: 850 } }); await request.post("/fixture/lose-mail-response-once");
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByLabel("Message").fill("Old uncertain message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Second workspace");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("workspace-2");
  await page.waitForTimeout(1100);
  await expect(page.locator("#notice")).not.toContainText("Delivery is uncertain");
  await page.getByLabel("Workspace", { exact: true }).selectOption("workspace-1");
  await expect(page.locator(".mail-delivery-warning")).toBeVisible();
});

test("delayed successful reply clears its original draft after navigation", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { send: 700 } });
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const composer = page.getByLabel("Message"); await composer.fill("Delayed reply review");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(composer).toHaveValue("", { timeout: 3000 });
});

test("mail result updates a replacement composer after navigation", async ({ page, request }) => {
  await unlock(page); await request.post("/fixture/delay", { data: { send: 650 } });
  const chats = await openTree(page, "Chats"); await chats.getByRole("button", { name: "#general", exact: true }).click();
  const composer = page.getByLabel("Message"); await composer.fill("Delayed success");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(composer).toHaveValue("Delayed success");
  await expect(composer).toHaveValue("", { timeout: 3000 });

  await request.post("/fixture/lose-mail-response-once");
  await composer.fill("Delayed uncertain");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await chats.getByRole("button", { name: "@Alice", exact: true }).click();
  await chats.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toBeVisible({ timeout: 3000 });
  await expect(composer).toHaveValue("Delayed uncertain");
  await page.getByRole("button", { name: "Retry original message", exact: true }).click();
  await expect(page.locator(".mail-delivery-warning")).toHaveCount(0);
});

test("purpose and first agent invitation use generic prompt and observed registration", async ({ page, request, context }) => {
  await request.post("/fixture/fresh-workspace");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4174" });
  await unlock(page, false);
  await page.getByLabel("Workspace name").fill("Studio session");
  await page.getByLabel("Workspace purpose (optional)").fill("Review arrangement ideas");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const invite = page.locator(".onboarding-callout");
  await expect(invite).toContainText("Invite an agent");
  await invite.getByRole("button", { name: "Copy joining prompt" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Call workspace_intro");
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.find((entry: { operation: string }) => entry.operation === "workspace_create").args.purpose).toBe("Review arrangement ideas");
  await request.post("/fixture/agent-contact");
  await expect(invite).toContainText("Agent registered", { timeout: 10_000 });
  await expect(invite).not.toContainText("running");
  await invite.getByRole("button", { name: "Dismiss" }).click();
  await expect(invite).toHaveCount(0);
});

test("task status, priority, assignee and claim are visible", async ({ page, request }) => {
  await unlock(page); await openTree(page, "Tasks");
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await expect(page.locator(".task-list-row")).toContainText("Open · P2 · Unassigned");
  await page.getByLabel("Filter tasks by status").selectOption("closed");
  await expect(page.locator(".task-list-row")).toHaveCount(0);
  await page.getByLabel("Filter tasks by status").selectOption("all");
  await page.locator(".task-list-row").getByRole("button", { name: /Fixture task/ }).click();
  await expect(page.locator(".task-metadata")).toContainText("Open · P2 · Unassigned");
  await page.getByRole("button", { name: "Claim task" }).click();
  await expect(page.locator(".task-metadata")).toContainText("Assigned to Owner");
  await expect(page.getByRole("button", { name: "Claim task" })).toHaveCount(0);
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.find((entry: { operation: string }) => entry.operation === "task_claim").args.participant_id).toBe("owner");
});

test("a task you hold can be released back to open", async ({ page, request }) => {
  await unlock(page); await openTree(page, "Tasks");
  await page.getByRole("button", { name: "All tasks", exact: true }).click();
  await page.locator(".task-list-row").getByRole("button", { name: /Fixture task/ }).click();
  await expect(page.getByRole("button", { name: "Release task" })).toHaveCount(0);
  await page.getByRole("button", { name: "Claim task" }).click();
  await expect(page.locator(".task-metadata")).toContainText("Assigned to Owner");
  await page.getByRole("button", { name: "Release task" }).click();
  await expect(page.locator(".task-metadata")).toContainText("Open · P2 · Unassigned");
  await expect(page.getByRole("button", { name: "Claim task" })).toBeVisible();
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.calls.find((entry: { operation: string }) => entry.operation === "task_release").args.participant_id).toBe("owner");
});

test("responsive code surfaces stay contained and copy exact text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4174" });
  await unlock(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const code = page.locator(".code-block code").first(); await expect(code).not.toContainText("Loading"); const expected = await code.textContent();
  await page.locator(".code-block").first().getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, blocks: [...document.querySelectorAll<HTMLElement>(".code-block pre")].map((node) => ({ client: node.clientWidth, scroll: node.scrollWidth })) }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.blocks.some((block) => block.scroll >= block.client)).toBeTruthy();
});

test("the About page shows the version, source link, and copyable build info", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4174" });
  await request.post("/fixture/build", { data: { app_version: "0.2.0", server_version: "0.1.0", ui_hash: "a".repeat(64), revision: "4a4ceae265b38ccbff197882be48acfd8bf74d93", dirty: false } });
  await page.setViewportSize({ width: 400, height: 560 });
  await page.goto("/about.html");
  await expect(page.getByRole("heading", { name: "Orchard", exact: true })).toBeVisible();
  await expect(page.getByText("Version 0.2.0", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/algonormative/orchard");
  const build = page.locator(".about-build .code-block code");
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeHidden();
  await page.getByText("Build info", { exact: true }).click();
  await expect(build).toContainText("Revision: 4a4ceae265b38ccbff197882be48acfd8bf74d93");
  await expect(build).toContainText("Working tree: clean");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Copied.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await build.textContent());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  // Expanded, everything fits the fixed-size window.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  // Without a revision the tree is never reported clean.
  await request.post("/fixture/build", { data: { app_version: "0.2.0", server_version: "0.1.0", ui_hash: "a".repeat(64), dirty: false } });
  await page.reload(); await page.getByText("Build info", { exact: true }).click();
  await expect(build).toContainText("Working tree: unavailable");
  // Escape asks the desktop shell to close the window.
  await page.keyboard.press("Escape");
  await page.waitForURL("**/about/close");
});
