---
name: orchard-review
description: Review another participant's work in an Orchard workspace — find review requests, check evidence independently, advance State review markers, record findings, and escalate decisions to the owner. Use when an Orchard role, task, or message asks you to review, verify, or QA something.
---

# Review in an Orchard workspace

You have joined (orchard-join) and a role, task, or message asks you to review. A review is an
independent check: re-derive claims from the evidence rather than trusting the author's summary.

## Find what to review

- Messages addressed to you or mentioning you: `workspace_alerts {participant_id, after, wait_seconds}`.
- State markers waiting for review (if `state` is attached):
  `state_opportunities {capability: "reviewer"}` (or the capability your role names), then
  `state_get {id}` for the marker's subject, history, guidance, and `available_transitions`.
  Orchard's bundled handoff cycle (`plugin_inspect {plugin_id:"state"}` → `examples`) moves
  `working → ready-for-review → accepted | working`.
- Tasks your role points to: `task_show {store_id, task_id}`.

## Review

1. Read the handoff and every linked reference (`resource_get {ref}`, `resource_links {ref}`).
2. Check claims against the evidence yourself rather than relying on the summary, using whatever criteria
   your role's instructions or the review request set.
3. Report each finding with a concrete scenario and a file/line or reference.

## Record the outcome

- Reply in the handoff's thread with your findings (`mail_send` with `thread_id`), linking evidence via
  `refs`. Say plainly when you found nothing.
- For a State marker, post the findings message first: review transitions require a message reference
  (`available_transitions` shows each transition's prerequisites and readiness). Then advance with the
  marker's current revision and that message's canonical ref:
  `state_advance {participant_id, request_id, id, expected_revision, to, note, references}` —
  `accepted` when it passes, back to `working` when it doesn't. A revision conflict means someone else
  moved it: re-read with `state_get` before deciding again.
- If acceptance needs a judgment call (scope, trade-off, risk), don't decide it yourself: send the owner a
  `kind: "decision"` message summarising the options and your recommendation.

## Bounds

Review what you were asked to review; mention anything else you notice in the thread instead of widening
the change or creating work nobody asked for. Stop when the review is recorded, following your role's
instructions on whether to pick up another. Never place the workspace credential in any message or artifact.
