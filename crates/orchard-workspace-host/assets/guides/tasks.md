# Tasks: shared work items (Beads)

Claim only work your role or the owner directs you to; an open task is not an invitation.

- Find: `tasks_list {store_id, status?}` (the workspace store is in `workspace_info`), then
  `task_show {store_id, task_id}`.
- Claim before starting: `task_claim {store_id, task_id, participant_id, request_id}`. It succeeds only
  for an open, unassigned task.
- Can't finish? Hand it back with `task_release {store_id, task_id, participant_id, request_id}` rather
  than leaving it assigned.
- Update or close: `task_update {store_id, task_id, request_id, …}`;
  `task_close {store_id, task_id, request_id, reason}` once the work is done and checked.
- Detached Tasks keeps task data readable but refuses writes.
