# Orchard v0.2 plugins

## Plan

1. Keep a bundled, versioned registry in the host. It never downloads code,
   invokes scripts, or accepts provider supplied plugin definitions.
2. Persist attachment state, receipts, and State records in a workspace-local
   SQLite database. This is the sole attachment authority; configuration does
   not duplicate it.
3. Expose discovery (`plugin_list`, `plugin_inspect`) and the fixed gateway
   (`plugin_attach`, `plugin_detach`, `plugin_call`) through direct calls, the
   browser dispatcher, and each workspace MCP endpoint.
4. Gate module writes at both the named legacy operations and the gateway.
   Detaching Tasks or State retains data for reads but rejects its writes.
5. Ship State as a declarative finite-state module with immutable definitions,
   optimistic marker transitions, durable receipts, and history.

## Contract

`plugin_list` returns `{plugins:[{id,version,name,description,required,attached,operations}]}`.
`plugin_inspect {plugin_id}` returns
`{plugin:{id,version,name,description,required,attached,operations:[{name,description,input_schema}]}}`.
`plugin_attach` and `plugin_detach` accept `{plugin_id,request_id}` and return
the changed plugin plus the discovery fields. Reusing a request ID with the
same request replays its durable outcome; changing it is an error.

`plugin_call {plugin_id,operation,arguments}` permits only operations declared
by that bundled plugin. The host injects the active workspace ID and rejects a
nested or top-level foreign workspace ID. It cannot dispatch host/admin tools
or recursively call the gateway. Inspection contains schemas, so clients do
not need to refresh their MCP tool list after an attachment change.

Core and Chat are required. Tasks is attached by default for new and migrated
v0.2 workspaces. State starts detached. Detachment is a capability toggle, not
task-store detachment: files, Beads metadata, State data, and retained reads
survive it.

`plugin_attach` on Core or Chat is an idempotent required-capability no-op;
`plugin_detach` rejects them. Tasks admission is intentionally simple: a task
write admitted before a concurrent detach may finish, but no later write is
admitted. State checks attachment in its SQLite mutation transaction. Exact
durable State retries replay after a participant leaves or State detaches,
because they do not create a fresh write.

The host owns the registry, attachment state, State records, receipts, and
history in `<workspace>/.orchard/plugins.sqlite`; preserve it with its WAL,
SHM, and rollback-journal siblings in backups while the host is stopped.
Beads remains the authority for Tasks and Orchard Mail remains the authority
for Chat. Plugins cannot install external code, download manifests, run
scripts, or invoke an arbitrary host operation.

State operations are `state_define`, `state_definitions`, `state_create`,
`state_list`, `state_get`, `state_opportunities`, and `state_advance`.
Definitions are immutable, bounded records with an ID, positive integer
version, label, states, initial state, and declared edges. They may include
`state_guidance`, keyed by declared state, with advisory `instructions` and an
optional bounded `capabilities` list. An edge may include advisory
`instructions` and bounded prerequisites: `subject_task_closed`, or
`reference_kind` for `file`, `message`, or `task` evidence.

Markers store a definition reference, current state, revision, canonical
workspace-scoped subject, creator, and history. Define, create, and advance
require `request_id` and a registered `participant_id`. Advance also requires
`expected_revision`, a valid edge, and satisfied prerequisites. A task-subject
closure is checked through its qualified Beads task reference. Reference
evidence must be submitted in the advance request, be canonical and
same-workspace, and resolve; file evidence is pinned to a full Git SHA.
Missing evidence is reported as `needs_input`; supplied but unresolved evidence
and unavailable task subjects are `blocked`.

`state_get` retains its existing marker, definition, history, and
`available_transitions` fields, enriching each transition with
`readiness: ready|blocked|needs_input` and `reasons`. It adds applicable
state guidance and the observed task or `task_error` for task subjects.
`state_opportunities {state?,capability?,unassigned?}` returns nonterminal
markers as `{opportunities:[{marker,resource,guidance?,task?,task_error?,
transitions}]}`. `resource` is the canonical State marker reference; a marker's
subject remains in `marker.subject`. `unassigned` only matches resolved,
task-subject markers whose observed Beads assignee is empty. Beads observations
are point-in-time reads: State makes no cross-store atomicity claim.

State remains declarative: it launches no model, process, or script. An exact
advance receipt replays before participant, attachment, task, or evidence
checks, including after a task later reopens. Fresh advances serialize by
workspace/request ID, perform bounded external evidence reads outside the State
SQLite transaction, then recheck State revision in the mutation transaction.

## Example

Discover the State contract, attach it, then create and advance one marker.
The `workspace_id` shown in direct calls is injected automatically through
MCP `plugin_call`.

```json
{"operation":"plugin_inspect","args":{"workspace_id":"w1","plugin_id":"state"}}
{"operation":"plugin_attach","args":{"workspace_id":"w1","plugin_id":"state","request_id":"attach-state-1"}}
{"operation":"state_define","args":{"workspace_id":"w1","participant_id":"alice","request_id":"flow-1","definition":{"id":"review","version":1,"label":"Review","states":["draft","approved"],"initial":"draft","state_guidance":{"draft":{"instructions":"Attach the reviewed file.","capabilities":["reviewer"]}},"transitions":[{"from":"draft","to":"approved","label":"approve","prerequisites":[{"kind":"reference_kind","resource_kind":"file"}]}]}}}
{"operation":"state_create","args":{"workspace_id":"w1","participant_id":"alice","request_id":"marker-1","id":"proposal-7","title":"Proposal 7","definition_id":"review","definition_version":1,"subject":{"kind":"channel","workspace_id":"w1","id":"general"}}}
{"operation":"state_opportunities","args":{"workspace_id":"w1","capability":"reviewer"}}
{"operation":"state_advance","args":{"workspace_id":"w1","participant_id":"alice","request_id":"advance-1","id":"proposal-7","expected_revision":1,"to":"approved","note":"Reviewed","references":[{"kind":"file","workspace_id":"w1","root_id":"artifacts","path":"review.md","revision":"0123456789abcdef0123456789abcdef01234567"}]}}
```

## Acceptance

- Registry only exposes bundled manifests and validates all plugin and
  operation identifiers.
- Attachment state, receipts, definitions, markers, and histories are durable
  and transactionally committed in a workspace-local SQLite store.
- Detached Tasks and State allow retained reads but reject writes, including
  legacy named calls and `plugin_call`.
- State validates definition bounds, participants, canonical same-workspace
  references, pinned file subjects and evidence, legal transitions,
  prerequisite observations, and compare-and-swap revisions.
- `resource_get` supports `kind: state`; snapshots and workspace discovery
  include the plugin array; State mutations invalidate `state`, while attachment
  changes invalidate `plugins`.
