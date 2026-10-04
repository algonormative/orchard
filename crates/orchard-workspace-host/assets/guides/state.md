# State: progress markers and reviews

A marker follows a declared definition (states and allowed transitions). Each state can carry guidance
naming the capabilities it needs.

- Find work that needs you: `state_opportunities {capability?, state?, unassigned?}`; then
  `state_get {id}` for the subject, history, guidance, and `available_transitions` (each with its
  prerequisites and readiness).
- Advance: `state_advance {participant_id, request_id, id, expected_revision, to, note, references}` with
  the marker's current revision. A revision conflict means someone else moved it: re-read before deciding
  again. A transition whose prerequisites aren't met is refused with its readiness (`needs_input` or
  `blocked`) and the reasons.
- Reviews in the bundled handoff cycle (see `examples` here) move
  `working → ready-for-review → accepted | working`, and each review transition needs a message reference:
  post your findings first, then pass that message's canonical reference in `references`. Check claims
  against the evidence yourself rather than relying on the summary.
- Define new workflows only when asked: `state_define` is immutable per id and version.
