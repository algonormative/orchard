//! One bounded server-side check for edits made outside Orchard's call paths.
use crate::{config::WorkspaceConfig, events::EventHub, HostInner};
use git2::Repository;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Weak};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const MAX_FILES: usize = 2048;

#[derive(Clone, Copy, Eq, PartialEq)]
struct Fingerprint {
    hash: u64,
    periodic_resync: bool,
}

pub(crate) async fn run(host: Weak<HostInner>, cancellation: CancellationToken) {
    let mut previous = HashMap::<String, Fingerprint>::new();
    let mut last_fallback = Instant::now();
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = interval.tick() => {}
        }
        let Some(host) = host.upgrade() else { break };
        let workspaces = host.config.lock().unwrap().workspaces.clone();
        let hubs = host
            .runtimes
            .read()
            .unwrap()
            .iter()
            .map(|(id, runtime)| (id.clone(), runtime.events.clone()))
            .collect::<HashMap<String, Arc<EventHub>>>();
        drop(host);
        let Ok(fingerprints) = tokio::task::spawn_blocking(move || {
            workspaces
                .into_iter()
                .filter(|workspace| !workspace.archived && hubs.contains_key(&workspace.id))
                .map(|workspace| {
                    let hub = hubs.get(&workspace.id).unwrap().clone();
                    (workspace.id.clone(), fingerprint(&workspace), hub)
                })
                .collect::<Vec<_>>()
        })
        .await
        else {
            break;
        };
        let fallback = last_fallback.elapsed() >= Duration::from_secs(60);
        for (id, current, hub) in fingerprints {
            if let Some(old) = previous.insert(id, current) {
                if old.hash != current.hash || (fallback && current.periodic_resync) {
                    hub.publish_resync();
                }
            }
        }
        if fallback {
            last_fallback = Instant::now();
        }
    }
}

fn fingerprint(workspace: &WorkspaceConfig) -> Fingerprint {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut truncated = false;
    git_head(&workspace.mail_path, &mut hasher);
    for store in &workspace.task_stores {
        store.id.hash(&mut hasher);
        beads_revision(&store.db_path, &mut hasher);
        metadata(&store.path.join(".beads/issues.jsonl"), &mut hasher);
    }
    let mut remaining = MAX_FILES;
    let owned_artifacts = workspace.root.join("artifacts");
    git_head(&owned_artifacts, &mut hasher);
    metadata(&owned_artifacts.join(".git/index"), &mut hasher);
    walk_metadata(
        &owned_artifacts,
        &mut remaining,
        &mut truncated,
        &mut hasher,
    );
    for repo in &workspace.repositories {
        repo.id.hash(&mut hasher);
        match Repository::open(&repo.path) {
            Ok(git) => {
                head(&git, &mut hasher);
                metadata(&git.path().join("index"), &mut hasher);
                if let (Ok(index), Some(workdir)) = (git.index(), git.workdir()) {
                    index.len().hash(&mut hasher);
                    for entry in index.iter().take(MAX_FILES) {
                        let path = workdir.join(String::from_utf8_lossy(&entry.path).as_ref());
                        metadata(&path, &mut hasher);
                    }
                    truncated |= index.len() > MAX_FILES;
                }
            }
            Err(error) => format!("{:?}", error.code()).hash(&mut hasher),
        }
    }
    Fingerprint {
        hash: hasher.finish(),
        // Attached worktrees can gain untracked files, and a Beads JSONL import
        // can upsert issues without appending audit events. The slow fallback
        // covers both without a full scan.
        periodic_resync: truncated
            || !workspace.repositories.is_empty()
            || !workspace.task_stores.is_empty(),
    }
}

fn beads_revision(path: &Path, hasher: &mut impl Hasher) {
    path.hash(hasher);
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => {
            // Beads writes an audit event for each task mutation. SQLite file
            // mtimes also change on read-side housekeeping, so they cannot be
            // used as a browser invalidation signal.
            match connection.query_row("SELECT MAX(id) FROM events", [], |row| {
                row.get::<_, Option<i64>>(0)
            }) {
                Ok(revision) => revision.hash(hasher),
                Err(error) => format!("{error}").hash(hasher),
            }
        }
        Err(error) => format!("{error}").hash(hasher),
    }
}

fn git_head(path: &Path, hasher: &mut impl Hasher) {
    match Repository::open(path) {
        Ok(repo) => head(&repo, hasher),
        Err(error) => format!("{:?}", error.code()).hash(hasher),
    }
}

fn head(repo: &Repository, hasher: &mut impl Hasher) {
    match repo.head() {
        Ok(reference) => reference.target().map(|oid| oid.to_string()).hash(hasher),
        Err(error) => format!("{:?}", error.code()).hash(hasher),
    }
}

fn metadata(path: &Path, hasher: &mut impl Hasher) {
    path.hash(hasher);
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            meta.len().hash(hasher);
            meta.file_type().is_symlink().hash(hasher);
            meta.is_dir().hash(hasher);
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .hash(hasher);
        }
        Err(error) => error.kind().hash(hasher),
    }
}

fn walk_metadata(
    path: &Path,
    remaining: &mut usize,
    truncated: &mut bool,
    hasher: &mut impl Hasher,
) {
    metadata(path, hasher);
    if *remaining == 0 {
        *truncated = true;
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name() != ".git")
        .take(*remaining + 1)
        .collect::<Vec<_>>();
    if entries.len() > *remaining {
        *truncated = true;
        entries.truncate(*remaining);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *remaining == 0 {
            *truncated = true;
            break;
        }
        *remaining -= 1;
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            metadata(&path, hasher);
            continue;
        };
        if kind.is_dir() && !kind.is_symlink() {
            walk_metadata(&path, remaining, truncated, hasher);
        } else {
            metadata(&path, hasher);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_directory_exhausts_budget_without_underflow() {
        let temp = tempfile::TempDir::new().unwrap();
        fs::create_dir(temp.path().join("a")).unwrap();
        fs::write(temp.path().join("a/child"), b"one").unwrap();
        fs::write(temp.path().join("b"), b"two").unwrap();
        let mut remaining = 2;
        let mut truncated = false;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        walk_metadata(temp.path(), &mut remaining, &mut truncated, &mut hasher);
        assert_eq!(remaining, 0);
        assert!(truncated);
    }
}
