# Cooperative handoffs

[`examples/handoff.json`](../examples/handoff.json) is an opt-in State
definition for a small, reusable handoff cycle:

```text
working -> ready-for-review -> accepted
                    |
                    -> working
```

Attach State, inspect its `state_define` schema, and submit the checked-in JSON
as the definition. Create a marker for the work item using a canonical
workspace resource as its subject. The definition is deliberately generic: it
does not assign people, select work, or start any action.

While `working`, make one bounded contribution. To advance to
`ready-for-review`, include both an existing pinned file reference and the
message reference for the handoff. In that message, identify:

- the current contributor and next contributor;
- the exact files and/or ports being relinquished;
- checks run and other evidence;
- open issues; and
- the recommended next action.

Use `ready-for-review -> working` to record a revision request and resume
bounded revision work. To advance to `accepted`, attach a message that
explicitly records the accepted decision (and any follow-up). `accepted`
records that decision; it does not prove independent review.

State reference prerequisites only validate that the supplied references exist
and are canonical for this workspace; a canonical file reference must include a
full revision. They do not evaluate the artifact, message, review quality, or
decision. This convention is cooperative: it creates no ownership locks,
scheduler, automatic actions, or assurance that a reviewer is independent.
Participants should coordinate scope and relinquish ownership explicitly rather
than treating a marker as an exclusive claim.

Use the State operations exposed by the already-running Orchard workspace
through your normal harness. If the optional packaged agent CLI is present in
your installation, its transport details are documented in
[the agent CLI guide](agent-cli.md); inspect the live operation schemas rather
than assuming a command form or credential location.
