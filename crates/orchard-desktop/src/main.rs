#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "macos"))]
compile_error!("orchard-desktop is a macOS-only menu bar application");

use orchard_update::UpdateStatus;
use orchard_workspace_host::{HostError, ServerHandle, WorkspaceHost};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "orchard-tray";
const REFRESH_INTERVAL: Duration = Duration::from_secs(5);
const MAX_RECENT_WORKSPACES: usize = 5;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct LaunchOptions {
    data_dir: Option<PathBuf>,
    port: Option<u16>,
    br_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceMenuEntry {
    id: String,
    name: String,
    root: PathBuf,
}

struct DesktopState {
    host: Arc<WorkspaceHost>,
    shutdown: Mutex<ShutdownState>,
    base_url: String,
    update_check_in_flight: AtomicBool,
    applied_menu_entries: Mutex<Vec<WorkspaceMenuEntry>>,
}

struct ShutdownState {
    server: Option<ServerHandle>,
    phase: ShutdownPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownPhase {
    Running,
    Stopping,
    Stopped,
}

impl ShutdownState {
    fn begin(&mut self) -> Option<ServerHandle> {
        if self.phase != ShutdownPhase::Running {
            return None;
        }
        self.phase = ShutdownPhase::Stopping;
        self.server.take()
    }
}

fn main() {
    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    if arguments.first().and_then(|argument| argument.to_str()) == Some("agent") {
        if let Err(error) = tauri::async_runtime::block_on(orchard_server::agent_client::run_cli(
            arguments.into_iter().skip(1).collect(),
        )) {
            eprintln!("Orchard agent: {error}");
            std::process::exit(error.code.into());
        }
        return;
    }
    let options = match LaunchOptions::parse(env::args_os().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("Orchard: {error}");
            std::process::exit(2);
        }
    };

    tauri::Builder::default()
        .menu(app_menu)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let data_dir = options
                .data_dir
                .clone()
                .or_else(|| env::var_os("ORCHARD_DATA_DIR").map(PathBuf::from))
                .unwrap_or_else(|| app.path().data_dir().expect("macOS data directory").join("Orchard"));
            let port = if let Some(port) = options.port {
                Some(port)
            } else {
                match env_port() {
                    Ok(port) => port,
                    Err(error) => {
                        show_startup_error(app.handle(), &error);
                        return Ok(());
                    }
                }
            };
            let br_path = options
                .br_path
                .clone()
                .or_else(|| env::var_os("ORCHARD_BR_PATH").map(PathBuf::from))
                .unwrap_or_else(|| bundled_br_path(app.handle()));

            let host = match WorkspaceHost::open_with_port(data_dir, br_path, port) {
                Ok(host) => {
                    if let Some(version) = orchard_server::app_version() {
                        host.set_app_version(&version);
                    }
                    Arc::new(host)
                }
                Err(HostError::AlreadyRunning) => {
                    app.dialog()
                        .message("Another Orchard service already owns this data directory. The existing service was left running and no data was changed.")
                        .title("Orchard is already running")
                        .kind(MessageDialogKind::Warning)
                        .blocking_show();
                    app.handle().exit(0);
                    return Ok(());
                }
                Err(error) => {
                    show_startup_error(app.handle(), &error.to_string());
                    return Ok(());
                }
            };
            let server = match tauri::async_runtime::block_on(
                host.clone().start_server_with_ui(orchard_server::ui_router()),
            ) {
                Ok(server) => server,
                Err(error) => {
                    show_startup_error(app.handle(), &error.to_string());
                    return Ok(());
                }
            };
            let base_url = format!("http://{}", server.endpoint());
            let state = Arc::new(DesktopState {
                host,
                shutdown: Mutex::new(ShutdownState {
                    server: Some(server),
                    phase: ShutdownPhase::Running,
                }),
                base_url,
                update_check_in_flight: AtomicBool::new(false),
                applied_menu_entries: Mutex::new(Vec::new()),
            });
            app.manage(state.clone());
            install_tray(app.handle(), &state)?;
            spawn_menu_refresh(app.handle().clone(), state);
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(tauri::generate_context!())
        .expect("failed to build Orchard desktop shell")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the About window (the only window) is not a request to quit.
                if code.is_none() {
                    api.prevent_exit();
                    return;
                }
                if let Some(state) = app.try_state::<Arc<DesktopState>>() {
                    let phase = state.shutdown.lock().unwrap().phase;
                    if phase != ShutdownPhase::Stopped {
                        api.prevent_exit();
                        if phase == ShutdownPhase::Running {
                            graceful_quit(app.clone(), &state);
                        }
                    }
                }
            }
        });
}

impl LaunchOptions {
    fn parse<I>(args: I) -> Result<Self, String>
    where
        I: IntoIterator,
        I::Item: Into<std::ffi::OsString>,
    {
        let mut args = args.into_iter().map(Into::into);
        let mut options = Self::default();
        while let Some(argument) = args.next() {
            let text = argument.to_string_lossy();
            match text.as_ref() {
                "--data-dir" => {
                    options.data_dir = Some(PathBuf::from(next_value("--data-dir", &mut args)?))
                }
                "--br-path" => {
                    options.br_path = Some(PathBuf::from(next_value("--br-path", &mut args)?))
                }
                "--port" => {
                    let raw = next_value("--port", &mut args)?;
                    options.port = Some(parse_port(&raw.to_string_lossy())?);
                }
                "--help" | "-h" => {
                    return Err(
                        "usage: Orchard [--data-dir PATH] [--port PORT] [--br-path PATH]"
                            .to_owned(),
                    )
                }
                _ => return Err(format!("unknown argument {text:?}")),
            }
        }
        Ok(options)
    }
}

fn next_value(
    name: &str,
    args: &mut impl Iterator<Item = std::ffi::OsString>,
) -> Result<std::ffi::OsString, String> {
    args.next()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| format!("invalid port {value:?}; expected 1-65535"))
}

fn env_port() -> Result<Option<u16>, String> {
    env::var("ORCHARD_PORT")
        .ok()
        .map(|value| parse_port(&value).map_err(|error| format!("ORCHARD_PORT: {error}")))
        .transpose()
}

fn bundled_br_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resource_dir()
        .expect("Orchard resource directory")
        .join("bin/br")
}

fn workspace_entries(host: &WorkspaceHost) -> Result<Vec<WorkspaceMenuEntry>, String> {
    let result = host.call("workspace_list", json!({}))?;
    Ok(workspace_entries_from_list(&result))
}

fn workspace_entries_from_list(result: &Value) -> Vec<WorkspaceMenuEntry> {
    let active = active_workspace_entries_from_list(result);
    let recent_ids = result["recent_workspace_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let mut visible = Vec::with_capacity(MAX_RECENT_WORKSPACES);
    for id in recent_ids {
        if visible
            .iter()
            .any(|entry: &WorkspaceMenuEntry| entry.id == id)
        {
            continue;
        }
        if let Some(entry) = active.iter().find(|entry| entry.id == id) {
            visible.push(entry.clone());
            if visible.len() == MAX_RECENT_WORKSPACES {
                return visible;
            }
        }
    }
    for entry in active {
        if !visible.iter().any(|visible| visible.id == entry.id) {
            visible.push(entry);
            if visible.len() == MAX_RECENT_WORKSPACES {
                break;
            }
        }
    }
    visible
}

fn active_workspace_entries_from_list(result: &Value) -> Vec<WorkspaceMenuEntry> {
    result["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|workspace| !workspace["archived"].as_bool().unwrap_or(false))
        .filter_map(|workspace| {
            Some(WorkspaceMenuEntry {
                id: workspace["id"].as_str()?.to_owned(),
                name: workspace["name"].as_str()?.to_owned(),
                root: PathBuf::from(workspace["root"].as_str()?),
            })
        })
        .collect()
}

fn workspace_entry(host: &WorkspaceHost, workspace_id: &str) -> Option<WorkspaceMenuEntry> {
    let result = host.call("workspace_list", json!({})).ok()?;
    active_workspace_entries_from_list(&result)
        .into_iter()
        .find(|entry| entry.id == workspace_id)
}

fn workspace_path(id: &str) -> String {
    format!("/w/{}", utf8_percent_encode(id, NON_ALPHANUMERIC))
}

fn settings_path(id: &str) -> String {
    format!("{}/settings", workspace_path(id))
}

fn pending_menu_snapshot(
    previous: &[WorkspaceMenuEntry],
    current: Result<Vec<WorkspaceMenuEntry>, String>,
) -> Option<Vec<WorkspaceMenuEntry>> {
    current.ok().filter(|current| current != previous)
}

fn record_applied_menu(
    previous: &mut Vec<WorkspaceMenuEntry>,
    candidate: Vec<WorkspaceMenuEntry>,
    set_succeeded: bool,
) {
    if set_succeeded {
        *previous = candidate;
    }
}

fn install_tray<R: Runtime>(app: &AppHandle<R>, state: &Arc<DesktopState>) -> tauri::Result<()> {
    let entries = workspace_entries(&state.host).unwrap_or_default();
    let menu = build_menu(app, &entries)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon())
        .icon_as_template(true)
        .tooltip("Orchard")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)?;
    *state.applied_menu_entries.lock().unwrap() = entries;
    Ok(())
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[WorkspaceMenuEntry],
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if entries.is_empty() {
        let create = MenuItem::with_id(
            app,
            "create-workspace",
            "Create a Workspace…",
            true,
            None::<&str>,
        )?;
        menu.append(&create)?;
    } else {
        for entry in entries {
            let workspace = Submenu::new(app, &entry.name, true)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("workspace:{}", entry.id),
                "Open Web UI",
                true,
                None::<&str>,
            )?)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("settings:{}", entry.id),
                "Settings",
                true,
                None::<&str>,
            )?)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("copy-prompt:{}", entry.id),
                "Copy Prompt",
                true,
                None::<&str>,
            )?)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("copy-path:{}", entry.id),
                "Copy Path",
                true,
                None::<&str>,
            )?)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("finder:{}", entry.id),
                "Show in Finder",
                true,
                None::<&str>,
            )?)?;
            workspace.append(&MenuItem::with_id(
                app,
                format!("editor:{}", entry.id),
                "Open in Editor",
                true,
                None::<&str>,
            )?)?;
            menu.append(&workspace)?;
        }
    }
    let all_workspaces =
        MenuItem::with_id(app, "all-workspaces", "All Workspaces…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let about = MenuItem::with_id(app, "about", "About Orchard", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orchard", true, None::<&str>)?;
    menu.append(&all_workspaces)?;
    menu.append(&separator)?;
    menu.append(&about)?;
    menu.append(&updates)?;
    menu.append(&quit)?;
    Ok(menu)
}

fn spawn_menu_refresh<R: Runtime>(app: AppHandle<R>, state: Arc<DesktopState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            let app_for_main = app.clone();
            let state_for_main = state.clone();
            if app
                .run_on_main_thread(move || {
                    let candidate = {
                        let previous = state_for_main.applied_menu_entries.lock().unwrap();
                        pending_menu_snapshot(&previous, workspace_entries(&state_for_main.host))
                    };
                    let Some(candidate) = candidate else { return };
                    let set_succeeded = match (
                        app_for_main.tray_by_id(TRAY_ID),
                        build_menu(&app_for_main, &candidate),
                    ) {
                        (Some(tray), Ok(menu)) => tray.set_menu(Some(menu)).is_ok(),
                        _ => false,
                    };
                    record_applied_menu(
                        &mut state_for_main.applied_menu_entries.lock().unwrap(),
                        candidate,
                        set_succeeded,
                    );
                })
                .is_err()
            {
                break;
            }
        }
    });
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<Arc<DesktopState>>();
    match id {
        "create-workspace" => open_local(app, &state.base_url, "/"),
        "all-workspaces" => open_local(app, &state.base_url, "/workspaces"),
        "about" => show_about(app, &state.base_url),
        "check-updates" => {
            check_for_updates(app.clone(), state.inner().clone());
        }
        "quit" => graceful_quit(app.clone(), &state),
        _ => {
            if let Some(workspace_id) = id.strip_prefix("workspace:") {
                visit_workspace(&state.host, workspace_id);
                open_local(app, &state.base_url, &workspace_path(workspace_id));
            } else if let Some(workspace_id) = id.strip_prefix("settings:") {
                visit_workspace(&state.host, workspace_id);
                open_local(app, &state.base_url, &settings_path(workspace_id));
            } else if let Some(workspace_id) = id.strip_prefix("copy-prompt:") {
                visit_workspace(&state.host, workspace_id);
                copy_joining_prompt(app, &state.host, workspace_id);
            } else if let Some(workspace_id) = id.strip_prefix("copy-path:") {
                visit_workspace(&state.host, workspace_id);
                if let Some(entry) = workspace_entry(&state.host, workspace_id) {
                    copy_text(app, entry.root.to_string_lossy().into_owned());
                }
            } else if let Some(workspace_id) = id.strip_prefix("finder:") {
                visit_workspace(&state.host, workspace_id);
                with_workspace_root(app, &state.host, workspace_id, |root| {
                    app.opener()
                        .reveal_item_in_dir(root)
                        .map_err(|error| format!("Could not show the workspace in Finder: {error}"))
                });
            } else if let Some(workspace_id) = id.strip_prefix("editor:") {
                visit_workspace(&state.host, workspace_id);
                with_workspace_root(app, &state.host, workspace_id, open_in_editor);
            }
        }
    }
}

fn visit_workspace(host: &WorkspaceHost, workspace_id: &str) {
    let _ = host.call("workspace_visit", json!({"workspace_id": workspace_id}));
}

fn with_workspace_root<R: Runtime>(
    app: &AppHandle<R>,
    host: &WorkspaceHost,
    workspace_id: &str,
    action: impl FnOnce(&Path) -> Result<(), String>,
) {
    let root = workspace_entry(host, workspace_id).map(|entry| entry.root);
    let result = match root {
        Some(root) if root.is_dir() => action(&root),
        Some(root) => Err(format!(
            "Workspace folder is unavailable: {}",
            root.display()
        )),
        None => Err("Workspace is no longer available.".to_owned()),
    };
    if let Err(error) = result {
        show_action_error(app, &error);
    }
}

fn open_in_editor(root: &Path) -> Result<(), String> {
    let editor = resolve_editor_app().ok_or_else(|| {
        "No supported editor was found. Install Cursor, Visual Studio Code, or Zed, or set ORCHARD_EDITOR_APP to an application name or path.".to_owned()
    })?;
    let output = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(&editor)
        .arg("--")
        .arg(root)
        .output()
        .map_err(|error| format!("Could not open the editor: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if detail.is_empty() {
            "The selected editor could not open this workspace.".to_owned()
        } else {
            format!("The selected editor could not open this workspace: {detail}")
        })
    }
}

fn resolve_editor_app() -> Option<OsString> {
    if let Some(configured) = env::var_os("ORCHARD_EDITOR_APP").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(&configured);
        if path.components().count() > 1 && !path.exists() {
            return None;
        }
        return Some(configured);
    }
    ["Cursor", "Visual Studio Code", "Zed"]
        .into_iter()
        .find(|name| {
            Path::new("/Applications")
                .join(format!("{name}.app"))
                .is_dir()
        })
        .map(OsString::from)
}

/// The app menu, used while an Orchard window (About) is focused. It replaces Tauri's
/// default, whose Quit calls `terminate:` and so skips the server's graceful shutdown: here
/// ⌘Q is an ordinary item routed to `graceful_quit`, like the tray's Quit. Edit keeps copy
/// and select-all working in the About window.
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let orchard = Submenu::with_items(
        app,
        "Orchard",
        true,
        &[
            &MenuItem::with_id(app, "about", "About Orchard", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Orchard", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;
    Menu::with_items(app, &[&orchard, &edit, &window])
}

fn graceful_quit<R: Runtime>(app: AppHandle<R>, state: &DesktopState) {
    let server = state.shutdown.lock().unwrap().begin();
    let Some(server) = server else { return };
    let state = app.state::<Arc<DesktopState>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = server.shutdown().await;
        state.shutdown.lock().unwrap().phase = ShutdownPhase::Stopped;
        app.exit(0);
    });
}

fn check_for_updates<R: Runtime>(app: AppHandle<R>, state: Arc<DesktopState>) {
    if state
        .update_check_in_flight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = orchard_update::check_for_updates(env!("CARGO_PKG_VERSION")).await;
        let app_for_main = app.clone();
        let state_for_main = state.clone();
        if app
            .run_on_main_thread(move || {
                state_for_main
                    .update_check_in_flight
                    .store(false, Ordering::Release);
                if state_for_main.shutdown.lock().unwrap().phase != ShutdownPhase::Running {
                    return;
                }
                match result {
                    Ok(update) if update.status == UpdateStatus::UpdateAvailable => {
                        let open = app_for_main
                            .dialog()
                            .message(format!(
                                "Orchard {} is available. Open the release page?",
                                update.latest_version
                            ))
                            .title("Orchard Update Available")
                            .kind(MessageDialogKind::Info)
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "Open Release".to_owned(),
                                "Later".to_owned(),
                            ))
                            .blocking_show();
                        if open {
                            if let Err(error) = app_for_main
                                .opener()
                                .open_url(update.release_url, None::<&str>)
                            {
                                show_action_error(
                                    &app_for_main,
                                    &format!("Could not open the release page: {error}"),
                                );
                            }
                        }
                    }
                    Ok(update) => {
                        app_for_main
                            .dialog()
                            .message(format!("Orchard {} is up to date.", update.latest_version))
                            .title("Orchard Updates")
                            .blocking_show();
                    }
                    Err(error) => show_action_error(&app_for_main, &error.to_string()),
                }
            })
            .is_err()
        {
            state.update_check_in_flight.store(false, Ordering::Release);
        }
    });
}

fn copy_joining_prompt<R: Runtime>(app: &AppHandle<R>, host: &WorkspaceHost, workspace_id: &str) {
    match host.call("workspace_intro", json!({"workspace_id": workspace_id})) {
        Ok(value) => match value["joining_prompt"].as_str() {
            Some(prompt) => copy_text(app, prompt.to_owned()),
            None => show_action_error(app, "This workspace has no joining prompt."),
        },
        Err(error) => show_action_error(app, &error),
    }
}

fn copy_text<R: Runtime>(app: &AppHandle<R>, text: String) {
    match app.clipboard().write_text(text) {
        Ok(()) => {}
        Err(error) => show_action_error(app, &format!("Could not copy: {error}")),
    }
}

const ABOUT_WINDOW: &str = "about";
const ABOUT_PAGE: &str = "/about.html";
const ABOUT_NOTICES: &str = "/about/notices";
const ABOUT_CLOSE: &str = "/about/close";

/// Where a navigation inside the About window goes.
#[derive(Debug, PartialEq, Eq)]
enum AboutNavigation {
    /// The About page itself loads in the window.
    Stay,
    /// The notices link opens the bundled notices folder.
    Notices,
    /// Escape on the page asks for the window to close.
    Close,
    /// An https link opens in the default browser.
    Browser,
    /// Anything else is refused.
    Refuse,
}

fn about_navigation(base_url: &str, url: &tauri::Url) -> AboutNavigation {
    let local = tauri::Url::parse(base_url)
        .map(|base| base.origin() == url.origin())
        .unwrap_or(false);
    match (local, url.path()) {
        (true, ABOUT_PAGE) => AboutNavigation::Stay,
        (true, ABOUT_NOTICES) => AboutNavigation::Notices,
        (true, ABOUT_CLOSE) => AboutNavigation::Close,
        (false, _) if url.scheme() == "https" => AboutNavigation::Browser,
        _ => AboutNavigation::Refuse,
    }
}

/// Opens (or brings forward) the About window: the embedded About page with the version,
/// a GitHub link, and an expandable build identity. The page is plain local content with
/// no Tauri commands; links leave the window through [`about_navigation`].
fn show_about<R: Runtime>(app: &AppHandle<R>, base_url: &str) {
    if let Some(window) = app.get_webview_window(ABOUT_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let url = match tauri::Url::parse(&format!("{base_url}{ABOUT_PAGE}")) {
        Ok(url) => url,
        Err(error) => {
            return show_action_error(app, &format!("Could not open About Orchard: {error}"))
        }
    };
    let handle = app.clone();
    let base = base_url.to_owned();
    let built =
        tauri::WebviewWindowBuilder::new(app, ABOUT_WINDOW, tauri::WebviewUrl::External(url))
            .title("About Orchard")
            .inner_size(400.0, 560.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .center()
            .on_navigation(move |url| match about_navigation(&base, url) {
                AboutNavigation::Stay => true,
                AboutNavigation::Notices => {
                    if let Err(error) = open_notices(&handle) {
                        show_action_error(&handle, &error);
                    }
                    false
                }
                AboutNavigation::Close => {
                    if let Some(window) = handle.get_webview_window(ABOUT_WINDOW) {
                        let _ = window.close();
                    }
                    false
                }
                AboutNavigation::Browser => {
                    if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
                        show_action_error(&handle, &format!("Could not open the link: {error}"));
                    }
                    false
                }
                AboutNavigation::Refuse => false,
            })
            .build();
    match built {
        // A menu-bar app is never active on its own; focusing activates it so the window
        // opens in front.
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => show_action_error(app, &format!("Could not open About Orchard: {error}")),
    }
}

fn open_notices<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let notices = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate notices: {error}"))?
        .join("notices");
    app.opener()
        .open_path(notices.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open notices: {error}"))
}

fn show_action_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    app.dialog()
        .message(message)
        .title("Orchard")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn show_startup_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    app.dialog()
        .message(format!(
            "Orchard could not start its local service: {message}"
        ))
        .title("Orchard could not start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    app.exit(1);
}

fn open_local<R: Runtime>(app: &AppHandle<R>, base_url: &str, path: &str) {
    let url = format!("{base_url}{path}");
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        app.dialog()
            .message(format!("Could not open Orchard in the browser: {error}"))
            .title("Orchard")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }
}

fn tray_icon() -> Image<'static> {
    const RASTER_SIZE: u32 = 36;
    Image::new_owned(render_tray_icon(RASTER_SIZE), RASTER_SIZE, RASTER_SIZE)
}

fn render_tray_icon(size: u32) -> Vec<u8> {
    const LOGICAL_SIZE: f32 = 18.0;
    const STROKE: f32 = 1.35;
    const CROWNS: [(f32, f32, f32); 3] = [(3.75, 6.0, 1.9), (9.0, 3.0, 1.9), (14.25, 6.0, 1.9)];
    const SEGMENTS: [((f32, f32), (f32, f32)); 4] = [
        ((9.0, 5.6), (9.0, 15.4)),
        ((3.75, 8.55), (9.0, 10.9)),
        ((14.25, 8.55), (9.0, 10.9)),
        ((6.6, 15.4), (11.4, 15.4)),
    ];
    const SAMPLES: u32 = 4;

    let scale = size as f32 / LOGICAL_SIZE;
    let mut rgba = vec![0_u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let mut covered = 0_u32;
            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let point = (
                        (x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32) / scale,
                        (y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32) / scale,
                    );
                    let crown = CROWNS.iter().any(|&(cx, cy, radius)| {
                        let distance = ((point.0 - cx).powi(2) + (point.1 - cy).powi(2)).sqrt();
                        (distance - radius).abs() <= STROKE / 2.0
                    });
                    let branch = SEGMENTS.iter().any(|&(start, end)| {
                        point_to_segment_distance(point, start, end) <= STROKE / 2.0
                    });
                    if crown || branch {
                        covered += 1;
                    }
                }
            }
            let offset = ((y * size + x) * 4) as usize;
            rgba[offset + 3] = ((covered * 255) / (SAMPLES * SAMPLES)) as u8;
        }
    }
    rgba
}

fn point_to_segment_distance(point: (f32, f32), start: (f32, f32), end: (f32, f32)) -> f32 {
    let delta = (end.0 - start.0, end.1 - start.1);
    let length_squared = delta.0 * delta.0 + delta.1 * delta.1;
    let projection = (((point.0 - start.0) * delta.0 + (point.1 - start.1) * delta.1)
        / length_squared)
        .clamp(0.0, 1.0);
    let nearest = (
        start.0 + projection * delta.0,
        start.1 + projection * delta.1,
    );
    ((point.0 - nearest.0).powi(2) + (point.1 - nearest.1).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_isolated_smoke_options() {
        let options = LaunchOptions::parse([
            "--data-dir",
            "/tmp/orchard-smoke",
            "--port",
            "43121",
            "--br-path",
            "/tmp/br",
        ])
        .unwrap();
        assert_eq!(options.data_dir, Some(PathBuf::from("/tmp/orchard-smoke")));
        assert_eq!(options.port, Some(43121));
        assert_eq!(options.br_path, Some(PathBuf::from("/tmp/br")));
    }

    #[test]
    fn rejects_zero_and_unknown_arguments() {
        assert!(LaunchOptions::parse(["--port", "0"]).is_err());
        assert!(LaunchOptions::parse(["--surprise"]).is_err());
    }

    #[test]
    fn malformed_port_env_uses_the_error_path() {
        assert!(parse_port("not-a-port").is_err());
        assert!(parse_port("0").is_err());
    }

    #[test]
    fn about_window_keeps_its_page_and_sends_links_out() {
        let base = "http://127.0.0.1:64640";
        let go = |url: &str| about_navigation(base, &tauri::Url::parse(url).unwrap());
        assert_eq!(
            go("http://127.0.0.1:64640/about.html"),
            AboutNavigation::Stay
        );
        assert_eq!(
            go("http://127.0.0.1:64640/about/notices"),
            AboutNavigation::Notices
        );
        assert_eq!(
            go("http://127.0.0.1:64640/about/close"),
            AboutNavigation::Close
        );
        assert_eq!(
            go("https://github.com/algonormative/orchard"),
            AboutNavigation::Browser
        );
        // Other local pages, other ports, and plain http stay out of the window.
        assert_eq!(go("http://127.0.0.1:64640/w/x"), AboutNavigation::Refuse);
        assert_eq!(go("http://127.0.0.1:1/about.html"), AboutNavigation::Refuse);
        assert_eq!(go("http://example.com/"), AboutNavigation::Refuse);
        assert_eq!(go("file:///etc/passwd"), AboutNavigation::Refuse);
    }

    #[test]
    fn routes_encode_workspace_ids_and_never_include_credentials() {
        assert_eq!(workspace_path("a/b c"), "/w/a%2Fb%20c");
        assert_eq!(settings_path("a/b c"), "/w/a%2Fb%20c/settings");
    }

    #[test]
    fn workspace_menu_reads_live_host_records() {
        let temp = tempfile::tempdir().unwrap();
        let br = temp.path().join("br");
        std::fs::write(&br, "not executed by this test").unwrap();
        let host = WorkspaceHost::open(temp.path().join("data"), br).unwrap();
        host.call("workspace_create", json!({"name":"Live menu"}))
            .unwrap();
        let entries = workspace_entries(&host).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Live menu");
    }

    #[test]
    fn recent_workspace_order_is_visible_and_capped_at_five() {
        let workspaces = (0..7)
            .map(|index| {
                json!({
                    "id": format!("workspace-{index}"),
                    "name": format!("Workspace {index}"),
                    "root": format!("/tmp/workspace-{index}"),
                    "archived": index == 6,
                })
            })
            .collect::<Vec<_>>();
        let result = json!({
            "workspaces": workspaces,
            "recent_workspace_ids": ["workspace-4", "workspace-2", "workspace-6", "unknown"]
        });
        let ids = workspace_entries_from_list(&result)
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "workspace-4",
                "workspace-2",
                "workspace-0",
                "workspace-1",
                "workspace-3"
            ]
        );
    }

    #[test]
    fn missing_recent_ids_use_stable_workspace_order() {
        let result = json!({
            "workspaces": [
                {"id":"a", "name":"A", "root":"/tmp/a", "archived":false},
                {"id":"b", "name":"B", "root":"/tmp/b", "archived":false}
            ]
        });
        let ids = workspace_entries_from_list(&result)
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["a", "b"]);
    }

    #[test]
    fn bundled_br_relative_path_is_stable() {
        assert_eq!(PathBuf::from("bin").join("br"), PathBuf::from("bin/br"));
    }

    #[test]
    fn repeated_shutdown_requests_do_not_take_the_server_twice() {
        let mut state = ShutdownState {
            server: None,
            phase: ShutdownPhase::Running,
        };
        assert!(state.begin().is_none());
        assert_eq!(state.phase, ShutdownPhase::Stopping);
        assert!(state.begin().is_none());
        assert_eq!(state.phase, ShutdownPhase::Stopping);
    }

    #[test]
    fn unchanged_workspace_snapshot_does_not_replace_native_menu() {
        let entries = vec![WorkspaceMenuEntry {
            id: "workspace-one".to_owned(),
            name: "One".to_owned(),
            root: PathBuf::from("/tmp/one"),
        }];
        assert_eq!(pending_menu_snapshot(&entries, Ok(entries.clone())), None);
    }

    #[test]
    fn changed_workspace_snapshot_replaces_native_menu() {
        let previous = vec![];
        let current = vec![WorkspaceMenuEntry {
            id: "workspace-one".to_owned(),
            name: "One".to_owned(),
            root: PathBuf::from("/tmp/one"),
        }];
        assert_eq!(
            pending_menu_snapshot(&previous, Ok(current.clone())),
            Some(current)
        );
    }

    #[test]
    fn failed_read_or_native_set_preserves_applied_snapshot() {
        let entry = WorkspaceMenuEntry {
            id: "workspace-one".to_owned(),
            name: "One".to_owned(),
            root: PathBuf::from("/tmp/one"),
        };
        let mut applied = vec![entry.clone()];
        assert_eq!(
            pending_menu_snapshot(&applied, Err("read failed".to_owned())),
            None
        );
        record_applied_menu(&mut applied, Vec::new(), false);
        assert_eq!(applied, vec![entry]);
    }
}
