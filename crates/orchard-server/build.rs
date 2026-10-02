use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let workspace = manifest.join("../..");
    let dist = workspace.join("ui/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let desktop_manifest = workspace.join("crates/orchard-desktop/Cargo.toml");
    println!("cargo:rerun-if-changed={}", desktop_manifest.display());
    println!("cargo:rerun-if-env-changed=ORCHARD_VERSION");
    let desktop_version = package_version(&desktop_manifest);
    let app_version = release_version(&desktop_version);
    let server_version = env::var("CARGO_PKG_VERSION").expect("server package version");
    let mut files = Vec::new();
    collect_files(&dist, &dist, &mut files).unwrap_or_else(|error| {
        panic!(
            "could not read {}: {error}; run `npm --prefix ui run build` first",
            dist.display()
        )
    });
    files.sort();
    assert!(
        files.iter().any(|path| path == "index.html"),
        "ui/dist/index.html is missing; run `npm --prefix ui run build` first"
    );
    for relative in &files {
        println!("cargo:rerun-if-changed={}", dist.join(relative).display());
    }
    let ui_hash = embedded_ui_hash(&dist, &files);
    let git = git_identity(&workspace);
    if git.revision.is_some() {
        emit_git_reruns(&workspace);
    }
    let build_info = build_info_json(&app_version, &server_version, &ui_hash, git);

    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("build output")).join("embedded_assets.rs");
    let mut generated = fs::File::create(output).expect("create embedded asset source");
    writeln!(
        generated,
        "pub const BUILD_INFO_JSON: &str = {build_info:?};"
    )
    .unwrap();
    writeln!(generated, "pub const ASSETS: &[(&str, &[u8])] = &[").unwrap();
    for relative in files {
        let include_path = format!("/../../ui/dist/{relative}");
        writeln!(
            generated,
            "    ({relative:?}, include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), {include_path:?}))),"
        )
        .unwrap();
    }
    writeln!(generated, "];").unwrap();
}

fn package_version(manifest: &Path) -> String {
    let source = fs::read_to_string(manifest)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", manifest.display()));
    let mut in_package = false;
    for line in source.lines() {
        let line = line.trim();
        if line == "[package]" {
            in_package = true;
            continue;
        }
        if in_package && line.starts_with('[') {
            break;
        }
        if in_package && line.starts_with("version") {
            let Some((_, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim().trim_matches('"');
            if is_release_version(value) {
                return value.to_owned();
            }
            panic!("desktop package version must be a stable x.y.z version");
        }
    }
    panic!(
        "desktop package version is missing from {}",
        manifest.display()
    );
}

fn release_version(desktop_version: &str) -> String {
    match env::var("ORCHARD_VERSION") {
        Ok(version) => {
            assert!(
                is_release_version(&version),
                "ORCHARD_VERSION must be a stable x.y.z version"
            );
            assert_eq!(
                version, desktop_version,
                "ORCHARD_VERSION must match orchard-desktop's version"
            );
            version
        }
        Err(env::VarError::NotPresent) => desktop_version.to_owned(),
        Err(error) => panic!("could not read ORCHARD_VERSION: {error}"),
    }
}

fn is_release_version(value: &str) -> bool {
    let mut parts = value.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(major), Some(minor), Some(patch), None)
            if !major.is_empty()
                && !minor.is_empty()
                && !patch.is_empty()
                && major.bytes().all(|byte| byte.is_ascii_digit())
                && minor.bytes().all(|byte| byte.is_ascii_digit())
                && patch.bytes().all(|byte| byte.is_ascii_digit())
    )
}

#[derive(Clone, Copy)]
struct GitIdentity {
    revision: Option<[u8; 40]>,
    dirty: Option<bool>,
}

fn git_identity(workspace: &Path) -> GitIdentity {
    let Some(repository_root) = git_output(workspace, &["rev-parse", "--show-toplevel"]) else {
        return GitIdentity {
            revision: None,
            dirty: None,
        };
    };
    if fs::canonicalize(repository_root.trim()).ok() != fs::canonicalize(workspace).ok() {
        return GitIdentity {
            revision: None,
            dirty: None,
        };
    }
    let revision = git_output(workspace, &["rev-parse", "--verify", "HEAD"])
        .and_then(|value| value.trim().as_bytes().try_into().ok())
        .filter(|revision: &[u8; 40]| revision.iter().all(u8::is_ascii_hexdigit));
    // Dirty means tracked changes (staged or not), like `git describe --dirty`;
    // untracked files do not count.
    let dirty = git_output(
        workspace,
        &["status", "--porcelain", "--untracked-files=no"],
    )
    .map(|value| !value.is_empty());
    GitIdentity { revision, dirty }
}

/// Watches only files that exist. Watching the `.git` directory, or a path that is
/// missing (such as an absent `packed-refs`), makes Cargo rerun this script on every
/// build. Tracked files are watched individually, so working-tree edits refresh the
/// dirty flag without watching `ui/node_modules` or test output.
fn emit_git_reruns(workspace: &Path) {
    let mut paths = Vec::new();
    for path in ["HEAD", "index", "packed-refs"] {
        paths.extend(git_path(workspace, path));
    }
    if let Some(reference) = git_output(workspace, &["symbolic-ref", "-q", "HEAD"]) {
        paths.extend(git_path(workspace, reference.trim()));
    }
    for path in paths.into_iter().filter(|path| path.is_file()) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    if let Some(files) = git_output_bytes(workspace, &["ls-files", "-z"]) {
        for relative in files
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            if let Ok(relative) = std::str::from_utf8(relative) {
                let path = workspace.join(relative);
                // A deleted tracked file was watched by the previous run, so its removal
                // still reruns this script once; watching a missing path would rerun forever.
                if path.exists() {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
}

fn git_path(workspace: &Path, path: &str) -> Option<PathBuf> {
    git_output(workspace, &["rev-parse", "--git-path", path]).map(|value| {
        let path = PathBuf::from(value.trim());
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    })
}

fn git_output(workspace: &Path, args: &[&str]) -> Option<String> {
    String::from_utf8(git_output_bytes(workspace, args)?).ok()
}

fn git_output_bytes(workspace: &Path, args: &[&str]) -> Option<Vec<u8>> {
    // Optional locks would let `git status` touch `.git` and the index during the build.
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(workspace)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn build_info_json(
    app_version: &str,
    server_version: &str,
    ui_hash: &str,
    git: GitIdentity,
) -> String {
    let mut fields = vec![
        format!("\"app_version\":\"{app_version}\""),
        format!("\"server_version\":\"{server_version}\""),
        format!("\"ui_hash\":\"{ui_hash}\""),
    ];
    if let Some(revision) = git.revision {
        fields.push(format!(
            "\"revision\":\"{}\"",
            std::str::from_utf8(&revision).expect("hex revision")
        ));
    }
    if let Some(dirty) = git.dirty {
        fields.push(format!("\"dirty\":{dirty}"));
    }
    format!("{{{}}}", fields.join(","))
}

fn embedded_ui_hash(dist: &Path, files: &[String]) -> String {
    let mut hasher = Sha256::new();
    for relative in files {
        let bytes = fs::read(dist.join(relative))
            .unwrap_or_else(|error| panic!("could not read embedded asset {relative}: {error}"));
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    format!("{:x}", hasher.finalize())
}

fn collect_files(root: &Path, directory: &Path, output: &mut Vec<String>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_files(root, &path, output)?;
        } else if entry.file_type()?.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("asset below root")
                .to_str()
                .ok_or_else(|| io::Error::other("UI asset path is not UTF-8"))?;
            output.push(relative.replace('\\', "/"));
        }
    }
    Ok(())
}
