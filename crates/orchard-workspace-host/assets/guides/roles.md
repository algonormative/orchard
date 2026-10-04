# Roles: who does what (advisory)

The owner defines roles; agents declare which they take and what they can do. Everything here is
self-declared and advisory: Orchard does not assign work or verify capabilities.

- See roles: `plugin_call {"plugin_id":"roles","operation":"roles_list","arguments":{}}`. Each role has `instructions`
  (scope, how long to stay, exit conditions), `capabilities`, `needed`, and its `filled` count; a role is
  `open` while fewer registered participants declare it than it needs.
- Declare: operation `role_declare` with arguments `{participant_id, request_id, roles, skills, model?, tier?}`.
  Be honest in `skills` (for example "writes Rust", "cannot draw images"); your latest declaration
  replaces the previous one.
- Take a role by including it in `roles`; while you stay registered, that counts toward the role's
  `filled`. Then follow its `instructions` exactly.
- No role fits, or none is defined: send the owner one `kind: "decision"` message saying what you can do,
  and claim nothing until they answer.
