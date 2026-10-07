//! Kanban panel and app-only task tools over MCP stdio.
use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::io::{AsyncWriteExt, BufReader};
const HTML: &str = include_str!("../../dist/plugin/app.html");
const ICON: &[u8] = include_bytes!("../../plugins/kanban/assets/icon.svg");
fn icons() -> Value {
    json!([{"src":format!("data:image/svg+xml;base64,{}", STANDARD.encode(ICON)),"mimeType":"image/svg+xml","sizes":["any"]}])
}
fn uri() -> String {
    format!(
        "ui://chatgpt-kanban/panel-{}-{}.html",
        env!("CARGO_PKG_VERSION"),
        &hash(HTML)[..12]
    )
}
fn kanban_tools() -> Vec<Value> {
    [("kanban", "Kanban", true), ("kanban_update", "更新看板", false), ("kanban_execute", "执行任务", false)].into_iter().map(|(name,title,read)| {
        let mut meta = json!({"ui":{"resourceUri":uri(),"visibility":["app"]}});
        if read { meta["openai/ui"] = json!({"entrypoints":[{"type":"global"}]}); }
        let properties = if read { json!({"cardId":{"type":"string"}}) } else if name == "kanban_execute" {
            json!({"id":{"type":"string"},"revision":{"type":"integer"},"requestId":{"type":"string"},"agent":{"type":"string"},"prompt":{"type":"string"},"project":{"type":"string","maxLength":2000}})
        } else {
            json!({"id":{"type":"string"},"revision":{"type":"integer"},"action":{"enum":["create","edit","move","archive","link"]},"card":{"type":"object"},"stage":{"enum":["todo","doing","review","done"]},"beforeId":{"type":"string"},"archived":{"type":"boolean"},"link":{"type":["object","null"]}})
        };
        json!({"name":name,"title":title,"icons":icons(),"description":"Manage device-local kanban work items and their linked Agent tasks.","inputSchema":{"type":"object","properties":properties,"additionalProperties":false},"annotations":{"readOnlyHint":read,"destructiveHint":!read,"openWorldHint":!read},"_meta":meta})
    }).collect()
}
pub fn tools() -> Value {
    let mut tools = kanban_tools();
    for name in ["agents", "agent_tasks", "agent_read"] {
        let mut tool = catalog()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()
            .clone();
        tool["_meta"] = json!({"ui":{"visibility":["app"]}});
        tools.push(tool);
    }
    json!({"tools":tools})
}
async fn dispatch(client: Arc<runtime::Client>, request: Value) -> Value {
    let id = request["id"].clone();
    let params = &request["params"];
    let result: Result<Value> = match string(&request, "method") {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{},"resources":{}},
            "serverInfo":{"name":"chatgpt-kanban","version":env!("CARGO_PKG_VERSION"),"icons":icons()}}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools()),
        "resources/list" => Ok(
            json!({"resources":[{"uri":uri(),"name":"Kanban","mimeType":"text/html;profile=mcp-app"}]}),
        ),
        "resources/read" if params["uri"] == uri() => resource().await,
        "tools/call" => {
            let result = client.request("plugin/call", "POST", params.clone()).await;
            Ok(match result {
                Ok(value) => egress::tool(value, false),
                Err(error) => egress::tool(json!({"error":egress::failure(&error)}), true),
            })
        }
        _ => Err("method not found".into()),
    };
    match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":message}}),
    }
}
async fn resource() -> Result<Value> {
    let mut html = HTML.to_owned();
    let mut meta =
        json!({"ui":{"prefersBorder":false,"csp":{"connectDomains":[],"resourceDomains":[]}}});
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var("CHATGPT_KANBAN_DEV_HTML")
            .ok()
            .filter(|path| !path.is_empty())
        {
            // The explicit dev manifest owns this path. Release builds never read it.
            if let Ok(current) = std::fs::read_to_string(&path) {
                html = current;
            }
            let revision = hash(&html);
            meta["kanban/devRevision"] = json!(revision);
            meta["ui"]["csp"]["frameDomains"] = json!(["blob:"]);
            let config = json!({"uri":uri(),"revision":revision})
                .to_string()
                .replace('<', "\\u003c");
            let loader = include_str!("../../ui/plugin-dev.js");
            html = html.replace(
                "</body>",
                &format!("<script>window.__KANBAN_DEV__={config};{loader}</script></body>"),
            );
        }
    }
    Ok(
        json!({"contents":[{"uri":uri(),"mimeType":"text/html;profile=mcp-app","text":html,"_meta":meta}]}),
    )
}
pub async fn stdio() -> Result<()> {
    init_crypto();
    let client = runtime::Client::connect(runtime::binary()?, "plugin").await?;
    let mut reader = BufReader::new(tokio::io::stdin());
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut jobs = tokio::task::JoinSet::new();
    let mut waits = std::collections::HashMap::<String, tokio::task::AbortHandle>::new();
    loop {
        let bytes = crate::line(&mut reader, 1024 * 1024).await?;
        if bytes.is_empty() {
            break;
        }
        while let Some(Ok(key)) = jobs.try_join_next() {
            waits.remove(&key);
        }
        let request: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid JSON-RPC")?;
        if request["method"] == "notifications/cancelled" {
            if let Some(wait) = waits.remove(&request["params"]["requestId"].to_string()) {
                wait.abort();
            }
            continue;
        }
        if request["id"].is_null() {
            continue;
        }
        let key = request["id"].to_string();
        // Keep reading cancellation/EOF when the bounded request pool is full.
        if jobs.len() >= 8 || waits.contains_key(&key) {
            let mut out = stdout.lock().await;
            out.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"Too many requests or duplicate wait id"}})).as_bytes()).await.map_err(|e| e.to_string())?;
            out.flush().await.map_err(|e| e.to_string())?;
            continue;
        }
        let (out, completed) = (stdout.clone(), key.clone());
        let client = client.clone();
        let task = jobs.spawn(async move {
            let result = dispatch(client, request).await;
            if !result.is_null() {
                let mut o = out.lock().await;
                let _ = o.write_all(format!("{result}\n").as_bytes()).await;
                let _ = o.flush().await;
            }
            completed
        });
        waits.insert(key, task);
    }
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    client.close().await;
    Ok(())
}
