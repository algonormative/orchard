use axum::extract::ws::{Message, WebSocket};
use serde::Serialize;
use std::sync::{Condvar, Mutex};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
pub(crate) struct Event {
    #[serde(rename = "type")]
    kind: &'static str,
    workspace_id: String,
    revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    topics: Option<&'static [&'static str]>,
}

pub(crate) struct EventHub {
    workspace_id: String,
    revision: Mutex<u64>,
    sender: broadcast::Sender<Event>,
    pub(crate) cancellation: CancellationToken,
    /// Counts mail changes (and resyncs) so blocking-thread waiters need no runtime.
    mail_changes: Mutex<u64>,
    mail_changed: Condvar,
}

impl EventHub {
    pub(crate) fn new(workspace_id: String) -> Self {
        let (sender, _) = broadcast::channel(32);
        Self {
            workspace_id,
            revision: Mutex::new(0),
            sender,
            cancellation: CancellationToken::new(),
            mail_changes: Mutex::new(0),
            mail_changed: Condvar::new(),
        }
    }

    pub(crate) fn mail_mark(&self) -> u64 {
        *self.mail_changes.lock().unwrap()
    }

    /// Blocks the calling thread until mail changes after `mark`, `deadline` passes, or
    /// the hub is cancelled (shutdown or archive). Wakes at least once a second to notice
    /// cancellation. Returns whether a change was observed.
    pub(crate) fn wait_for_mail(&self, mark: u64, deadline: std::time::Instant) -> bool {
        let mut current = self.mail_changes.lock().unwrap();
        loop {
            if *current != mark {
                return true;
            }
            let now = std::time::Instant::now();
            if self.cancellation.is_cancelled() || now >= deadline {
                return false;
            }
            let slice = (deadline - now).min(Duration::from_secs(1));
            current = self.mail_changed.wait_timeout(current, slice).unwrap().0;
        }
    }

    fn note_mail_change(&self) {
        *self.mail_changes.lock().unwrap() += 1;
        self.mail_changed.notify_all();
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }

    pub(crate) fn hello(&self) -> Event {
        self.event("hello", None)
    }

    pub(crate) fn resync(&self) -> Event {
        self.event("resync", None)
    }

    fn event(&self, kind: &'static str, topics: Option<&'static [&'static str]>) -> Event {
        Event {
            kind,
            workspace_id: self.workspace_id.clone(),
            revision: *self.revision.lock().unwrap(),
            topics,
        }
    }

    pub(crate) fn publish(&self, topics: &'static [&'static str]) {
        if self.cancellation.is_cancelled() {
            return;
        }
        let mut revision = self.revision.lock().unwrap();
        *revision += 1;
        let _ = self.sender.send(Event {
            kind: "changed",
            workspace_id: self.workspace_id.clone(),
            revision: *revision,
            topics: Some(topics),
        });
        drop(revision);
        if topics.contains(&"mail") {
            self.note_mail_change();
        }
    }

    pub(crate) fn publish_resync(&self) {
        if self.cancellation.is_cancelled() {
            return;
        }
        let mut revision = self.revision.lock().unwrap();
        *revision += 1;
        let _ = self.sender.send(Event {
            kind: "resync",
            workspace_id: self.workspace_id.clone(),
            revision: *revision,
            topics: None,
        });
        drop(revision);
        self.note_mail_change();
    }
}

async fn send(socket: &mut WebSocket, event: Event) -> bool {
    let Ok(text) = serde_json::to_string(&event) else {
        return false;
    };
    timeout(
        Duration::from_secs(1),
        socket.send(Message::Text(text.into())),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

pub(crate) async fn serve(
    mut socket: WebSocket,
    hub: std::sync::Arc<EventHub>,
    session: CancellationToken,
) {
    let mut receiver = hub.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    let mut last_pong = Instant::now();
    if !send(&mut socket, hub.hello()).await {
        return;
    }
    loop {
        tokio::select! {
            _ = hub.cancellation.cancelled() => break,
            _ = session.cancelled() => break,
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(55)
                    || !timeout(Duration::from_secs(1), socket.send(Message::Ping(Vec::new().into())))
                        .await.is_ok_and(|result| result.is_ok())
                {
                    break;
                }
            }
            event = receiver.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => hub.resync(),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if !send(&mut socket, event).await { break; }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
    let _ = timeout(
        Duration::from_millis(100),
        socket.send(Message::Close(None)),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_subscriber_lag_requires_resync() {
        let hub = EventHub::new("one".to_owned());
        let mut subscriber = hub.subscribe();
        for _ in 0..64 {
            hub.publish(&["mail"]);
        }
        assert!(matches!(
            subscriber.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        let resync = hub.resync();
        assert_eq!(resync.kind, "resync");
        assert_eq!(resync.revision, 64);
    }
}
