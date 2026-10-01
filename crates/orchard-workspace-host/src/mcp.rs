use orchard_mail_mcp::{CoreBackend, ToolBackend, ToolDefinition};
use serde_json::{json, Value};
use std::sync::Weak;

use crate::{call_from_mcp, HostInner};

pub(crate) struct CombinedBackend {
    host: Weak<HostInner>,
    workspace_id: String,
    mail: CoreBackend,
}

impl CombinedBackend {
    pub(crate) fn new(host: Weak<HostInner>, workspace_id: String, mail: CoreBackend) -> Self {
        Self {
            host,
            workspace_id,
            mail,
        }
    }
}

impl ToolBackend for CombinedBackend {
    fn tools(&self) -> Vec<ToolDefinition> {
        let mut tools = self.mail.tools();
        tools.extend(task_tools());
        tools.extend(resource_tools());
        tools.extend(plugin_tools());
        tools
    }

    fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        match name {
            "tasks_list" | "workspace_info" | "task_show" | "task_create" | "task_update"
            | "task_claim" | "task_close" | "task_dependencies" | "resource_get"
            | "resource_links" | "resource_link" | "artifact_roots" | "artifact_list"
            | "artifact_history" | "artifact_upload" | "artifact_delete" | "artifact_commit"
            | "workspace_intro" | "workspace_status" | "workspace_alerts" => {
                call_from_mcp(&self.host, &self.workspace_id, name, args)
            }
            "plugin_list"
            | "plugin_inspect"
            | "plugin_attach"
            | "plugin_detach"
            | "plugin_call"
            | "state_define"
            | "state_definitions"
            | "state_create"
            | "state_list"
            | "state_get"
            | "state_opportunities"
            | "state_advance" => call_from_mcp(&self.host, &self.workspace_id, name, args),
            _ if self.mail.tools().iter().any(|tool| tool.name == name) => {
                call_from_mcp(&self.host, &self.workspace_id, name, args)
            }
            _ => Err(format!("unknown workspace tool {name:?}")),
        }
    }
}

pub(crate) fn resource_tools() -> Vec<ToolDefinition> {
    vec![
        tool(
            "workspace_intro",
            "Read the workspace README, current participant/channel directory, and credential-free joining guidance.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "workspace_status",
            "Read honest workspace counts, participant registration/contact observations, artifact availability, and errors.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "workspace_alerts",
            "Poll direct messages, mentions, broadcasts, replies, and optionally all delivered channel messages after a sequence cursor. Retrieval never acknowledges messages.",
            json!({
                "type":"object","properties":{
                    "participant_id":{"type":"string"},"after":{"type":"integer","minimum":0},
                    "limit":{"type":"integer","minimum":1,"maximum":200},
                    "include_channel_messages":{"type":"boolean","default":false}
                },"required":["participant_id"],"additionalProperties":false
            }),
        ),
        tool(
            "resource_get",
            "Read one canonical resource and its incoming and outgoing links.",
            json!({"type":"object","properties":{"ref":resource_ref_schema()},"required":["ref"],"additionalProperties":false}),
        ),
        tool(
            "resource_links",
            "Read incoming and outgoing links for one canonical resource.",
            json!({"type":"object","properties":{"ref":resource_ref_schema()},"required":["ref"],"additionalProperties":false}),
        ),
        tool(
            "resource_link",
            "Persist an immutable workspace-scoped link between two resources. Reuse request_id after a lost response.",
            json!({
                "type":"object","properties":{
                    "source":resource_ref_schema(),"target":resource_ref_schema(),
                    "label":{"type":"string"},"request_id":{"type":"string"}
                },"required":["source","target","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "artifact_roots",
            "List the owned artifact Git repository and attached Git repository roots.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "artifact_list",
            "List tracked entries without following symlinks or submodules. Supply a full Git revision for a pinned tree.",
            json!({
                "type":"object","properties":{
                    "root_id":{"type":"string"},"path":{"type":"string"},
                    "revision":{"type":"string","pattern":"^[0-9a-fA-F]{40}$"}
                },"required":["root_id"],"additionalProperties":false
            }),
        ),
        tool(
            "artifact_history",
            "List Git versions that changed one tracked file.",
            json!({
                "type":"object","properties":{"root_id":{"type":"string"},"path":{"type":"string"}},
                "required":["root_id","path"],"additionalProperties":false
            }),
        ),
        tool(
            "artifact_upload",
            "Upload at most 512 KiB to the workspace-owned artifacts repository and commit only that path and its request receipt.",
            json!({
                "type":"object","properties":{
                    "path":{"type":"string"},"content_base64":{"type":"string"},"request_id":{"type":"string"}
                },"required":["path","content_base64","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "artifact_delete",
            "Delete one tracked regular file from the workspace-owned artifacts repository, preserving Git history. Reuse request_id after a lost response.",
            json!({
                "type":"object","properties":{"path":{"type":"string"},"request_id":{"type":"string"}},
                "required":["path","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "artifact_commit",
            "Commit exactly the listed local regular-file changes or deletions from the workspace-owned artifact directory. Unrelated or staged changes are rejected.",
            json!({
                "type":"object","properties":{
                    "paths":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"string"}},
                    "request_id":{"type":"string"},"message":{"type":"string","maxLength":200}
                },"required":["paths","request_id"],"additionalProperties":false
            }),
        ),
    ]
}

pub(crate) fn resource_ref_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "kind":{"type":"string","enum":["channel","direct","broadcast","message","agent","task","state","file","url"]},
            "workspace_id":{"type":"string"},"id":{"type":"string"},"store_id":{"type":"string"},
            "task_id":{"type":"string"},"root_id":{"type":"string"},"path":{"type":"string"},
            "revision":{"type":"string"},"url":{"type":"string"}
        },
        "required":["kind","workspace_id"],"additionalProperties":false
    })
}

fn plugin_tools() -> Vec<ToolDefinition> {
    vec![
        tool(
            "plugin_list",
            "List bundled workspace plugins and their availability.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "plugin_inspect",
            "Inspect a bundled plugin and its operation schemas.",
            json!({"type":"object","properties":{"plugin_id":{"type":"string"}},"required":["plugin_id"],"additionalProperties":false}),
        ),
        tool(
            "plugin_attach",
            "Attach an optional bundled plugin idempotently.",
            json!({"type":"object","properties":{"plugin_id":{"type":"string"},"request_id":{"type":"string"}},"required":["plugin_id","request_id"],"additionalProperties":false}),
        ),
        tool(
            "plugin_detach",
            "Detach an optional bundled plugin while retaining its data for reads.",
            json!({"type":"object","properties":{"plugin_id":{"type":"string"},"request_id":{"type":"string"}},"required":["plugin_id","request_id"],"additionalProperties":false}),
        ),
        tool(
            "plugin_call",
            "Call one operation declared by a bundled plugin; workspace identity is injected.",
            json!({"type":"object","properties":{"plugin_id":{"type":"string"},"operation":{"type":"string"},"arguments":{"type":"object"}},"required":["plugin_id","operation","arguments"],"additionalProperties":false}),
        ),
        tool(
            "state_define",
            "Define an immutable declarative state machine.",
            state_schema("definition"),
        ),
        tool(
            "state_definitions",
            "List retained state definitions.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "state_create",
            "Create a state marker from a definition.",
            state_schema("create"),
        ),
        tool(
            "state_list",
            "List retained state markers.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "state_get",
            "Read a marker, definition, history, and legal next transitions.",
            json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}),
        ),
        tool(
            "state_opportunities",
            "Discover nonterminal State markers filtered by state, capability, or task assignment.",
            state_schema("opportunities"),
        ),
        tool(
            "state_advance",
            "Advance a marker with an expected revision.",
            state_schema("advance"),
        ),
    ]
}

pub(crate) fn state_schema(kind: &str) -> Value {
    match kind {
        "definition" => {
            json!({"type":"object","properties":{"participant_id":{"type":"string"},"request_id":{"type":"string"},"definition":{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"integer","minimum":1},"label":{"type":"string"},"states":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"string"}},"initial":{"type":"string"},"state_guidance":{"type":"object","maxProperties":64,"additionalProperties":{"type":"object","properties":{"instructions":{"type":"string","maxLength":4000},"capabilities":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":128}}},"required":["instructions"],"additionalProperties":false}},"transitions":{"type":"array","maxItems":256,"items":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"},"label":{"type":"string"},"instructions":{"type":"string","maxLength":4000},"prerequisites":{"type":"array","maxItems":32,"items":{"oneOf":[{"type":"object","properties":{"kind":{"const":"subject_task_closed"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"const":"reference_kind"},"resource_kind":{"enum":["file","message","task"]}},"required":["kind","resource_kind"],"additionalProperties":false}]}}},"required":["from","to"],"additionalProperties":false}}},"required":["id","version","label","states","initial","transitions"],"additionalProperties":false}},"required":["participant_id","request_id","definition"],"additionalProperties":false})
        }
        "create" => {
            json!({"type":"object","properties":{"participant_id":{"type":"string"},"request_id":{"type":"string"},"id":{"type":"string"},"title":{"type":"string"},"definition_id":{"type":"string"},"definition_version":{"type":"integer","minimum":1},"subject":resource_ref_schema()},"required":["participant_id","request_id","id","title","definition_id","definition_version","subject"],"additionalProperties":false})
        }
        "opportunities" => {
            json!({"type":"object","properties":{"state":{"type":"string","maxLength":128},"capability":{"type":"string","maxLength":128},"unassigned":{"type":"boolean"}},"additionalProperties":false})
        }
        _ => {
            json!({"type":"object","properties":{"participant_id":{"type":"string"},"request_id":{"type":"string"},"id":{"type":"string"},"expected_revision":{"type":"integer","minimum":1},"to":{"type":"string"},"note":{"type":"string"},"references":{"type":"array","maxItems":32,"items":resource_ref_schema()}},"required":["participant_id","request_id","id","expected_revision","to"],"additionalProperties":false})
        }
    }
}

pub(crate) fn task_tools() -> Vec<ToolDefinition> {
    vec![
        tool(
            "workspace_info",
            "Discover this endpoint's workspace, participants, attached repositories and task stores, and available capabilities. Credentials and other workspaces are never returned.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        tool(
            "tasks_list",
            "List tasks in one attached Beads store. Task identities are qualified by store_id.",
            json!({
                "type":"object",
                "properties":{"store_id":{"type":"string"},"status":{"type":"string"}},
                "required":["store_id"],"additionalProperties":false
            }),
        ),
        tool(
            "task_show",
            "Show one task from one attached Beads store.",
            task_ref_schema(),
        ),
        tool(
            "task_create",
            "Create one task idempotently. Reuse request_id after a lost response.",
            json!({
                "type":"object",
                "properties":{
                    "store_id":{"type":"string"},"request_id":{"type":"string"},
                    "title":{"type":"string"},"description":{"type":"string"},
                    "priority":{"type":"integer","minimum":0,"maximum":4},
                    "labels":{"type":"array","items":{"type":"string"}}
                },
                "required":["store_id","request_id","title"],"additionalProperties":false
            }),
        ),
        tool(
            "task_update",
            "Update only supplied task fields. Omitted description, dependencies, and labels are preserved.",
            json!({
                "type":"object",
                "properties":{
                    "store_id":{"type":"string"},"task_id":{"type":"string"},
                    "request_id":{"type":"string"},"description":{"type":"string"},
                    "title":{"type":"string"},
                    "status":{"type":"string"},
                    "priority":{"type":"integer","minimum":0,"maximum":4},
                    "add_labels":{"type":"array","items":{"type":"string"}},
                    "remove_labels":{"type":"array","items":{"type":"string"}}
                },
                "required":["store_id","task_id","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "task_claim",
            "Atomically claim one open, unassigned task as a registered participant. Reuse request_id after a lost response; an uncertain claim is never rerun automatically.",
            json!({
                "type":"object",
                "properties":{
                    "store_id":{"type":"string"},"task_id":{"type":"string"},
                    "participant_id":{"type":"string"},"request_id":{"type":"string"}
                },
                "required":["store_id","task_id","participant_id","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "task_close",
            "Close one task. Reuse request_id after a lost response and inspect reconciled responses.",
            json!({
                "type":"object",
                "properties":{
                    "store_id":{"type":"string"},"task_id":{"type":"string"},
                    "request_id":{"type":"string"},"reason":{"type":"string"}
                },
                "required":["store_id","task_id","request_id"],"additionalProperties":false
            }),
        ),
        tool(
            "task_dependencies",
            "Read both dependency directions for one qualified task.",
            task_ref_schema(),
        ),
    ]
}

pub(crate) fn host_tool_schema(name: &str) -> Option<Value> {
    task_tools()
        .into_iter()
        .chain(resource_tools())
        .find(|tool| tool.name == name)
        .map(|tool| tool.input_schema)
}

fn tool(name: &str, description: &str, input_schema: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema,
    }
}

fn task_ref_schema() -> Value {
    json!({
        "type":"object",
        "properties":{"store_id":{"type":"string"},"task_id":{"type":"string"}},
        "required":["store_id","task_id"],"additionalProperties":false
    })
}
