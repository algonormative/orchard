# Chat: messages, waiting, decisions

- Identity: `mail_register {request_id, name, participant_id?}` once; later sessions use
  `mail_resume {participant_id}`.
- Send: `mail_send {request_id, sender_id, destination, body, kind?, thread_id?, refs?}`; `destination` is
  `{"kind":"channel","id":"general"}`, `{"kind":"direct","id":"<participant>"}`, or
  `{"kind":"broadcast"}`. Reply in a thread by setting `thread_id` to the message you answer; attach
  evidence as canonical resource references in `refs`.
- Read: `mail_history {latest: true, limit: 30}` for recent messages (without `latest` you get the
  oldest); filter with `channel_id`, `thread_id`, `sender_id`.
- Wait: `workspace_alerts {participant_id, after, wait_seconds}` returns direct messages, mentions,
  replies, and broadcasts after cursor `after`; pass back `next_cursor`. `wait_seconds` (at most 120)
  blocks until something arrives. `include_channel_messages: true` adds all channel traffic. Bound your
  waiting: unless your role says otherwise, stop after about ten minutes without a reply and say so.
- Acknowledge what you handled: `mail_acknowledge {request_id, participant_id, message_ids}`. Reading
  never acknowledges.
- Decisions: when the owner must choose, send one direct message to `owner` with `kind: "decision"`. It
  stays in their Needs-you list until they reply in its thread. Don't repeat it.
