//! Business work items owned by Core. Agent state remains with its original owner.
use crate::*;
use std::time::Duration;

#[derive(Default)]
pub struct Kanban(Mutex<()>);

fn read() -> Result<Value> {
    let path = root().join("kanban.json");
    if !path.exists() {
        return Ok(json!({"revision":0,"cards":[]}));
    }
    let value = load(&path)?;
    if !value["revision"].is_u64() || !value["cards"].is_array() {
        return Err("INVALID_KANBAN_DATA".into());
    }
    Ok(value)
}
fn write(board: &mut Value) -> Result<()> {
    board["revision"] = json!(board["revision"].as_u64().unwrap() + 1);
    save(&root().join("kanban.json"), board)
}
fn index(board: &Value, card: &str) -> Result<usize> {
    board["cards"]
        .as_array()
        .unwrap()
        .iter()
        .position(|c| c["id"] == card)
        .ok_or("KANBAN_CARD_NOT_FOUND".into())
}
fn stage(value: &Value) -> Result<()> {
    if ["todo", "doing", "review", "done"].contains(&value.as_str().unwrap_or("")) {
        Ok(())
    } else {
        Err("INVALID_KANBAN_STAGE".into())
    }
}
fn fields(value: &Value) -> Result<Value> {
    let mut out = json!({});
    for (key, max) in [
        ("title", 240),
        ("description", 20000),
        ("project", 2000),
        ("labels", 500),
        ("due", 10),
    ] {
        let text = value[key].as_str().ok_or("INVALID_KANBAN_FIELDS")?.trim();
        if text.chars().count() > max || (key == "title" && text.is_empty()) {
            return Err("INVALID_KANBAN_FIELDS".into());
        }
        out[key] = json!(text);
    }
    if !string(&out, "due").is_empty()
        && chrono::NaiveDate::parse_from_str(string(&out, "due"), "%Y-%m-%d").is_err()
    {
        return Err("INVALID_KANBAN_DATE".into());
    }
    stage(&value["stage"])?;
    out["stage"] = value["stage"].clone();
    let checklist = value["checklist"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or("INVALID_KANBAN_CHECKLIST")?;
    let mut ids = std::collections::HashSet::new();
    for item in checklist {
        if uuid::Uuid::parse_str(string(item, "id")).is_err()
            || !ids.insert(string(item, "id"))
            || !item["done"].is_boolean()
            || item["text"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 500)
        {
            return Err("INVALID_KANBAN_CHECKLIST".into());
        }
    }
    out["checklist"] = json!(checklist);
    Ok(out)
}
fn terminal(receipt: &Value) -> bool {
    matches!(
        string(receipt, "state"),
        "completed" | "failed" | "rejected" | "not-executed"
    )
}
impl Kanban {
    pub async fn query(&self, service: &Arc<service::Service>, args: &Value) -> Result<Value> {
        let mut board = {
            let _guard = self.0.lock().await;
            read()?
        };
        let card_id = string(args, "cardId");
        if card_id.is_empty() {
            return Ok(board);
        }
        let i = index(&board, card_id)?;
        let run = board["cards"][i]["run"].clone();
        if run.is_object() {
            match service.agents.tool(&service.control, "agent_request", json!({"agent":run["arguments"]["agent"],"requestId":run["arguments"]["requestId"]})).await {
                Ok(receipt) => {
                    let task = receipt["taskId"].as_str().filter(|s| !s.is_empty());
                    if let Some(task) = task {
                        let _guard = self.0.lock().await;
                        board = read()?;
                        let i = index(&board, card_id)?;
                        let link = json!({"agent":run["arguments"]["agent"],"taskId":task});
                        if board["cards"][i]["run"] == run && board["cards"][i]["link"] != link {
                            board["cards"][i]["link"] = link;
                            write(&mut board)?;
                        }
                    }
                    board["receipt"] = receipt;
                }
                Err(error) => board["executionError"] = json!(error),
            }
        }
        let i = index(&board, card_id)?;
        let link = &board["cards"][i]["link"];
        if link.is_object()
            && (board["receipt"]["executionOwner"] != "desktop" || terminal(&board["receipt"]))
        {
            match service
                .agents
                .tool(&service.control, "agent_read", link.clone())
                .await
            {
                Ok(task) => board["execution"] = task,
                Err(error) => board["executionError"] = json!(error),
            }
        }
        board["cardId"] = json!(card_id);
        Ok(board)
    }
    pub async fn update(&self, service: &Arc<service::Service>, args: &Value) -> Result<Value> {
        let _guard = self.0.lock().await;
        let mut board = read()?;
        if args["revision"] != board["revision"] {
            return Err("KANBAN_CHANGED".into());
        }
        let card_id = string(args, "id");
        uuid::Uuid::parse_str(card_id).map_err(|_| "INVALID_KANBAN_ID")?;
        match string(args, "action") {
            "create" => {
                if index(&board, card_id).is_ok() {
                    return Ok(board);
                }
                let mut card = fields(&args["card"])?;
                card["id"] = json!(card_id);
                card["archived"] = json!(false);
                card["createdAt"] = json!(now());
                card["updatedAt"] = json!(now());
                board["cards"].as_array_mut().unwrap().push(card);
            }
            "edit" => {
                let i = index(&board, card_id)?;
                for (key, value) in fields(&args["card"])?.as_object().unwrap() {
                    board["cards"][i][key] = value.clone();
                }
                board["cards"][i]["updatedAt"] = json!(now());
            }
            "archive" => {
                let i = index(&board, card_id)?;
                if !args["archived"].is_boolean() {
                    return Err("INVALID_KANBAN_ARCHIVE".into());
                }
                board["cards"][i]["archived"] = args["archived"].clone();
                board["cards"][i]["updatedAt"] = json!(now());
            }
            "move" => {
                stage(&args["stage"])?;
                let i = index(&board, card_id)?;
                let cards = board["cards"].as_array_mut().unwrap();
                let mut card = cards.remove(i);
                if card["archived"] == true {
                    return Err("KANBAN_CARD_ARCHIVED".into());
                }
                card["stage"] = args["stage"].clone();
                card["updatedAt"] = json!(now());
                let before = string(args, "beforeId");
                let position = if before.is_empty() {
                    cards.len()
                } else {
                    cards
                        .iter()
                        .position(|c| {
                            c["id"] == before
                                && c["stage"] == args["stage"]
                                && c["archived"] == false
                        })
                        .ok_or("KANBAN_CHANGED")?
                };
                cards.insert(position, card);
            }
            "link" => {
                let i = index(&board, card_id)?;
                if board["cards"][i]["archived"] == true {
                    return Err("KANBAN_CARD_ARCHIVED".into());
                }
                let run = &board["cards"][i]["run"];
                if run.is_object() {
                    let receipt = service.agents.tool(&service.control, "agent_request", json!({"agent":run["arguments"]["agent"],"requestId":run["arguments"]["requestId"]})).await?;
                    if !terminal(&receipt) {
                        return Err("KANBAN_EXECUTION_PENDING".into());
                    }
                }
                let link = &args["link"];
                if !link.is_null() {
                    service
                        .agents
                        .tool(&service.control, "agent_read", link.clone())
                        .await?;
                }
                board["cards"][i]["link"] = link.clone();
                board["cards"][i].as_object_mut().unwrap().remove("run");
                board["cards"][i]["updatedAt"] = json!(now());
            }
            _ => return Err("UNKNOWN_KANBAN_ACTION".into()),
        }
        write(&mut board)?;
        Ok(board)
    }
    pub async fn execute(&self, service: &Arc<service::Service>, args: &Value) -> Result<Value> {
        let card_id = string(args, "id");
        let run = {
            let _guard = self.0.lock().await;
            let mut board = read()?;
            let i = index(&board, card_id)?;
            let previous = board["cards"][i]["run"].clone();
            if previous["arguments"]["requestId"] == args["requestId"] && previous.is_object() {
                previous
            } else {
                if args["revision"] != board["revision"] {
                    return Err("KANBAN_CHANGED".into());
                }
                if board["cards"][i]["archived"] == true {
                    return Err("KANBAN_CARD_ARCHIVED".into());
                }
                if previous.is_object() {
                    let receipt = service.agents.tool(&service.control, "agent_request", json!({"agent":previous["arguments"]["agent"],"requestId":previous["arguments"]["requestId"]})).await?;
                    if !terminal(&receipt) {
                        return Err("KANBAN_EXECUTION_PENDING".into());
                    }
                    if let Some(task) = receipt["taskId"].as_str().filter(|s| !s.is_empty()) {
                        board["cards"][i]["link"] =
                            json!({"agent":previous["arguments"]["agent"],"taskId":task});
                    }
                }
                uuid::Uuid::parse_str(string(args, "requestId"))
                    .map_err(|_| "INVALID_REQUEST_ID")?;
                let card = &board["cards"][i];
                let prompt = string(args, "prompt").trim();
                if prompt.is_empty() || prompt.chars().count() > 24000 {
                    return Err("INVALID_KANBAN_PROMPT".into());
                }
                let linked = card["link"].is_object();
                let mut arguments = json!({"agent":if linked {card["link"]["agent"].clone()} else {args["agent"].clone()},"requestId":args["requestId"],"prompt":prompt,"approval":"approved"});
                if linked {
                    arguments["taskId"] = card["link"]["taskId"].clone();
                } else {
                    let project = string(args, "project").trim();
                    if project.chars().count() > 2000
                        || !Path::new(project).is_absolute()
                        || !Path::new(project).is_dir()
                    {
                        return Err("KANBAN_DIRECTORY_REQUIRED".into());
                    }
                    arguments["cwd"] = json!(project);
                    arguments["title"] = card["title"].clone();
                }
                let name = if linked { "agent_send" } else { "agent_create" };
                let catalog = crate::catalog();
                let spec = catalog["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["name"] == name)
                    .unwrap();
                jsonschema::validator_for(&spec["inputSchema"])
                    .map_err(|e| e.to_string())?
                    .validate(&arguments)
                    .map_err(|e| e.to_string())?;
                let inventory = service.agents.ui_inventory(false).await;
                let available = inventory["agents"].as_array().is_some_and(|rows| {
                    rows.iter().any(|a| {
                        a["agent"] == arguments["agent"]
                            && a["enabled"] == true
                            && a["available"] == true
                    })
                });
                if !available {
                    return Err("AGENT_UNAVAILABLE".into());
                }
                let run = json!({"name":name,"arguments":arguments});
                if !linked {
                    board["cards"][i]["project"] = run["arguments"]["cwd"].clone();
                }
                board["cards"][i]["run"] = run.clone();
                board["cards"][i]["stage"] = json!("doing");
                board["cards"][i]["updatedAt"] = json!(now());
                write(&mut board)?;
                run
            }
        };
        // Persist the exact request before dispatch. A retry uses the same receipt and arguments.
        service
            .agents
            .tool(
                &service.control,
                string(&run, "name"),
                run["arguments"].clone(),
            )
            .await?;
        // Desktop-owned creation needs the host to reveal its newly seeded chat.
        // The panel can route that link in-process while the native request waits for ownership.
        if run["name"] == "agent_create" {
            for _ in 0..100 {
                let receipt = service.agents.tool(&service.control, "agent_request", json!({"agent":run["arguments"]["agent"],"requestId":run["arguments"]["requestId"]})).await?;
                if terminal(&receipt) || receipt["executionOwner"] != "desktop" {
                    break;
                }
                if let Some(task) = receipt["taskId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && receipt["state"] == "turn-submitting")
                {
                    let mut board = self.query(service, &json!({"cardId":card_id})).await?;
                    board["openUrl"] = json!(format!("codex://threads/{task}"));
                    return Ok(board);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        self.query(service, &json!({"cardId":card_id})).await
    }
}
