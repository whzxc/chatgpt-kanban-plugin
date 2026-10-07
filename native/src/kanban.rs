//! Business work items owned by Core. Agent state remains with its original owner.
use crate::*;
use std::time::Duration;

#[derive(Default)]
pub struct Kanban(Mutex<()>, Mutex<Option<(std::time::Instant, Vec<Value>)>>);

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
    // Native tasks remain owned by Codex; only explicit board edits are persisted.
    let cards: Vec<_> = board["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|card| card["discovered"] != true)
        .cloned()
        .collect();
    save(
        &root().join("kanban.json"),
        &json!({"revision":board["revision"],"cards":cards,
            "order":board["cards"].as_array().unwrap().iter().map(|c| c["id"].clone()).collect::<Vec<_>>()}),
    )
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
    async fn local_tasks(&self, service: &Arc<service::Service>) -> Result<Vec<Value>> {
        let mut cache = self.1.lock().await;
        if let Some((at, tasks)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return Ok(tasks.clone());
            }
        }
        let mut tasks = Vec::new();
        let mut args = json!({"agent":"codex","limit":200});
        let mut cursors = std::collections::HashSet::new();
        loop {
            let page = service
                .agents
                .tool(&service.control, "agent_tasks", args.clone())
                .await?;
            tasks.extend(
                page["tasks"]
                    .as_array()
                    .ok_or("INVALID_TASK_LIST")?
                    .iter()
                    .cloned(),
            );
            let Some(cursor) = page["nextCursor"].as_str().filter(|s| !s.is_empty()) else {
                break;
            };
            if !cursors.insert(cursor.to_owned()) {
                return Err("INVALID_TASK_CURSOR".into());
            }
            args["cursor"] = json!(cursor);
        }
        *cache = Some((std::time::Instant::now(), tasks.clone()));
        Ok(tasks)
    }
    async fn board(&self, service: &Arc<service::Service>) -> Result<Value> {
        let mut board = read()?;
        let tasks = match self.local_tasks(service).await {
            Ok(tasks) => tasks,
            Err(error) => {
                board["discoveryError"] = json!(error);
                self.1
                    .lock()
                    .await
                    .as_ref()
                    .map(|(_, tasks)| tasks.clone())
                    .unwrap_or_default()
            }
        };
        let order: std::collections::HashMap<String, usize> = board["order"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(i, id)| id.as_str().map(|id| (id.to_owned(), i)))
            .collect();
        let cards = board["cards"].as_array_mut().unwrap();
        let mut known: std::collections::HashSet<String> = cards
            .iter()
            .filter_map(|c| {
                (c["link"]["agent"] == "codex").then(|| string(&c["link"], "taskId").to_owned())
            })
            .collect();
        known.extend(cards.iter().map(|c| string(c, "id").to_owned()));
        for task in tasks {
            let id = string(&task, "taskId");
            if task["archived"] == true
                || uuid::Uuid::parse_str(id).is_err()
                || !known.insert(id.to_owned())
            {
                continue;
            }
            let title = [string(&task, "title"), string(&task, "preview"), id]
                .into_iter()
                .find(|s| !s.trim().is_empty())
                .unwrap()
                .lines()
                .next()
                .unwrap_or(id)
                .chars()
                .take(240)
                .collect::<String>();
            let waiting = task["activeFlags"].as_array().is_some_and(|flags| {
                flags.iter().any(|f| {
                    let f = f.as_str().unwrap_or("").to_lowercase();
                    f.contains("waiting") || f.contains("approval") || f.contains("input")
                })
            });
            let stage = if waiting {
                "review"
            } else if task["runtimeStatus"] == "active" {
                "doing"
            } else {
                "todo"
            };
            cards.push(
                json!({"id":id,"title":title,"description":"","project":string(&task,"cwd"),
                "labels":"","due":"","stage":stage,"checklist":[],"archived":false,
                "discovered":true,"link":{"agent":"codex","taskId":id}}),
            );
        }
        cards.sort_by_key(|card| order.get(string(card, "id")).copied().unwrap_or(usize::MAX));
        Ok(board)
    }

    pub async fn query(&self, service: &Arc<service::Service>, args: &Value) -> Result<Value> {
        let mut board = {
            let _guard = self.0.lock().await;
            self.board(service).await?
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
                        board = self.board(service).await?;
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
        let mut board = self.board(service).await?;
        if args["revision"] != board["revision"] {
            return Err("KANBAN_CHANGED".into());
        }
        let card_id = string(args, "id");
        if string(args, "action") != "create" {
            let i = index(&board, card_id)?;
            board["cards"][i]
                .as_object_mut()
                .unwrap()
                .remove("discovered");
        }
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
            let mut board = self.board(service).await?;
            let i = index(&board, card_id)?;
            board["cards"][i]
                .as_object_mut()
                .unwrap()
                .remove("discovered");
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
