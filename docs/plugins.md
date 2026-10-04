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

## Coupling between plugins

Optional plugins stay independent so that attaching, detaching, or adding one
never forces another. Every bundled plugin follows these rules:

1. **Hard dependencies are required plugins only.** A manifest's
   `dependencies` may name Core and Chat, never an optional plugin.
2. **No reaching in.** An optional plugin never reads another plugin's storage
   or calls its code. It uses the host's public operations or canonical
   resource references. When the other plugin is detached or unavailable, it
   reports that as data (State's `task_error` on a task subject), and its own
   operation still succeeds.
3. **Shared vocabulary is plain strings.** Capability names and labels such as
   `role:<id>` are conventions. No plugin validates another's vocabulary.
4. **Core composes, it does not depend.** A plugin may add a section to
   `workspace_intro` through its manifest's `intro_section` hook and to the
   browser snapshot through `snapshot_section`. Core iterates the bundled
   manifests and calls hooks only for attached plugins. A hook may return no
   section. Intro hook errors produce a one-line unavailable note; snapshot
   hook errors omit that section and add a source error. Core never names a
   specific optional plugin to do so.
5. **Soft links are declared.** `integrations` lists the optional plugins this
   one can use when they are attached. `plugin_list` and `plugin_inspect`
   return it, and Settings shows it ("Works with Tasks when attached").

State declares `integrations: ["tasks"]`: a task subject is read through
`task_show`, and the `subject_task_closed` prerequisite needs Tasks. A host
test checks rules 1 and 5 against the bundled catalog.

State's intro section counts markers in nonterminal states and points callers
to `state_opportunities` with a capability to find matching work. It disappears
when State is detached. State does not currently contribute a snapshot section.
The detach-matrix host test checks that detaching each optional plugin leaves
the other attached plugins' read operations usable.

Known exceptions, from before these rules, to migrate onto the hook: Core's
`workspace_info` and `workspace_status` report task stores and counts,
`workspace_snapshot` carries `task_stores`, the catalog checks the Beads
backend for Tasks' health, and `plugin_inspect` adds State's handoff example.

## Contract

`plugin_list` returns `{plugins:[{id,version,name,description,required,attached,dependencies,integrations,operations}]}`.
`plugin_inspect {plugin_id}` returns
`{plugin:{id,version,name,description,required,attached,operations:[{name,description,input_schema}]}}`.
State's inspection also carries `examples:[{name,definition}]`: ready-to-submit
`state_define` definitions, currently the opt-in `handoff` cycle from
[handoffs.md](handoffs.md). Examples are discovery only; nothing is defined
until a participant submits one.
`plugin_attach` and `plugin_detach` accept `{plugin_id,request_id}` and return
the changed plugin plus the discovery fields. Reusing a request ID with the
same request replays its durable outcome; changing it is an error.

`plugin_call {plugin_id,operation,arguments}` permits only operations declared
by that bundled plugin. The host injects the active workspace ID and rejects a
nested or top-level foreign workspace ID. It cannot dispatch host/admin tools
or recursively call the gateway. Inspection contains schemas, so clients do
not need to refresh their MCP tool list after an attachment change.

Core and Chat are required. Tasks and Roles are attached by default: a
workspace with no recorded attachment starts attached, while an explicit detach
persists. State starts detached. Detachment is a capability toggle, not
task-store detachment: files, Beads metadata, State and Roles data, and
retained reads survive it.

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

## Roles

Roles is an optional, default-attached advisory plugin. An owner defines roles
with a `needed` count; registered agents self-declare the roles and skills they
say they have. These declarations are informational only: Roles does not
enforce assignments, capabilities, models, or tiers.

The workspace-local `plugins.sqlite` stores owner role records in `role` and
append-only agent declarations in `role_declaration`. A declaration may name an
undefined role, which is retained but contributes to no role's count; only the
participant's latest declaration is current.

The manifest exposes `roles_list {}` and `role_declare {participant_id,
request_id, roles, skills, model?, tier?}` through `plugin_call`. `roles_list`
returns defined roles with their current coverage and the latest declaration
for each currently registered participant; it remains readable while Roles is
detached. `role_declare` requires a registered non-`orchard` participant and
an attached Roles plugin. Its request receipt makes an exact retry idempotent.

Host `call` (including the authenticated browser `/api/call`) also accepts
owner-only `role_put {request_id, role}` and `role_delete {request_id, role_id}`
to define, replace, or delete a role. They are intentionally not manifest
operations or MCP allowlist entries: `plugin_call` and the workspace MCP
endpoint do not expose them. Deleting a role leaves declarations untouched.

For a defined role `R`, `filled(R)` is the number of Chat
`mail_participants` with `registered == true`, excluding `orchard`, whose latest
declaration contains `R.id`. `open(R)` is `filled(R) < R.needed`; a role with
`needed: 0` is never open.

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
