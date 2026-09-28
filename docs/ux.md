# Orchard Workspace browser UX constraints

Start with a valid empty workspace. The first useful action is creating it;
the form asks for a name and offers an optional short purpose. Connection
configuration and technical records live in Settings or a selected object,
never in an empty dashboard. After creation, a compact invite callout offers a
generic joining prompt for an agent the user already runs and a link to
Connection settings. It observes actual participant registration before showing
a brief contact acknowledgment; opening or copying the prompt does not count
as a connection. An existing workspace with a registered agent starts on the
working surface without that first-contact prompt.

The LEMON visual treatment uses citron accents, terminal labels, and a small
mascot mark. The large synthetic orchard illustration appears on the calm home
and workspace chooser, not over a working conversation, form, or credential.

The visible workspace is a resource browser. One global tree starts with Chats,
Tasks, and Artifacts, and every selected resource opens in the single tabbed
viewer. Tabs deduplicate canonical Orchard resource paths and close back to a
neighbor or calm empty viewer. The tree only shows records supplied by the
workspace; it does not invent project hierarchies or activity.

The composer is a continuous working surface. Polling updates only the selected
conversation's scroll container and preserves a focused draft, reply context,
and reading position. A direct view shows the owner↔participant exchange; an
All direct messages view exposes owner-observable agent-to-agent routing with
sender and recipient attribution. Broadcast is its own readable conversation.
Channels use `#name` and participants use `@name` everywhere they are displayed;
those prefixes never change stored identifiers. The paperclip uploads a chosen
file immediately and keeps its pinned resource reference with the originating
draft while the user navigates. The resulting filename chip can be retried or
removed without deleting the uploaded artifact. HTTP(S) and canonical Orchard
links in prose are safe links, while fenced code remains exact plain text.
When a send response is uncertain, the draft stays visible and Orchard keeps
the original request ID and content for a retry. The composer labels that
uncertainty and asks the user to retry the original or explicitly keep an edited
draft as a new message, warning that the first send may already have landed.

Chat, task, agent, artifact, and attachment detail opens only when selected.
Each canonical resource offers Copy link, Add link, outgoing links, and
backlinks in the viewer. References remain readable, navigable records. The
internal `orchard` participant and
`task-receipts`/`orchard-system` channels do not crowd ordinary conversations.
Snapshot source errors and unavailable task stores appear as errors instead of
empty content. Actions have text labels and errors have text feedback; color is
supplementary.

Settings is the canonical `/w/{workspace}/settings` page and survives login,
reload, browser Back, and direct navigation. It starts with the compact workspace
introduction, an Open README action into the read-only artifact viewer, and
separately copyable joining prompt and workspace path. A collapsed Connection
details section exposes the per-workspace endpoint, credential copy actions,
and credential rotation. It explains that Orchard connects already-running
agents: the harness must reload its own MCP configuration, register or resume
an identity, poll its inbox, and acknowledge messages. It does not expose a
protocol log dashboard.

All code-like blocks use one shared renderer with text-node content, a visible
generic Copy control, and contained horizontal scrolling. This preserves the
exact copied source while keeping long commands, endpoints, tokens, and fenced
message snippets from widening the page. Secondary views have a visible exit,
Escape support, and browser Back returns to the prior in-app context. Polling
updates data without replacing an active form, task view, draft, reply state,
focus, or reader scroll position.

Tasks open to the workspace-owned store first. Projects are added by path and
shown by their basename; a project without a usable Beads store remains visible
with a plain status instead of being initialized automatically. Legacy external
stores stay available under Other task sources. Task rows and details show status,
priority when available, and assignment; the collection can be filtered by
status. An open unassigned task offers Claim task, which asks the host to claim
it for the registered owner. After a successful claim the view refreshes to
show the resulting assignment and in-progress status. A failed or uncertain
claim stays an error until the task is inspected; the interface does not infer
success from a matching assignee alone.

Artifact files open as friendly viewers: Markdown and code remain text-node
content with Copy controls, safe raster images use an inline preview, and every
other binary has a download fallback. Audio and video stay download-only in
this release. A file without a revision is labelled
Working copy; a selected revision is a pinned Git version. Resource links and
backlinks are navigable tabs, never a classification workflow. File and task
views are read-only apart from explicit task status actions; Orchard does not
embed a text or code editor.
