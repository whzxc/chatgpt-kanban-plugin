use crate::*;
pub struct Service {
    pub runtime: crate::runtime::State,
    pub control: Arc<control::Control>,
    pub agents: Arc<agents::AgentHost>,
    pub token: String,
    kanban: kanban::Kanban,
}
impl Service {
    pub fn new() -> Result<Arc<Self>> {
        private_dir(&root())?;
        let control = control::Control::new(
            desktop::installation()
                .map(|i| i.binary)
                .unwrap_or_else(|| PathBuf::from("codex")),
        );
        Ok(Arc::new(Self {
            runtime: Default::default(),
            control,
            agents: agents::AgentHost::new()?,
            token: id() + &id(),
            kanban: Default::default(),
        }))
    }
    pub async fn stop(&self) -> Result<()> {
        self.agents.close().await;
        self.control.close().await;
        Ok(())
    }
    pub async fn request(self: &Arc<Self>, route: &str, body: Value) -> Result<Value> {
        if route.starts_with("runtime/") {
            return self.runtime.request(route, body);
        }
        if route != "plugin/call" {
            return Err("UNKNOWN_ROUTE".into());
        }
        let name = string(&body, "name");
        let spec = plugin::tools()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .cloned()
            .ok_or("UNKNOWN_TOOL")?;
        let args = body.get("arguments").cloned().unwrap_or(json!({}));
        jsonschema::validator_for(&spec["inputSchema"])
            .map_err(|e| e.to_string())?
            .validate(&args)
            .map_err(|e| e.to_string())?;
        match name {
            "kanban" => self.kanban.query(self, &args).await,
            "kanban_update" => self.kanban.update(self, &args).await,
            "kanban_execute" => self.kanban.execute(self, &args).await,
            "agents" => Ok(self.agents.ui_inventory(false).await),
            "agent_tasks" | "agent_read" => self.agents.tool(&self.control, name, args).await,
            _ => Err("UNKNOWN_TOOL".into()),
        }
    }
}
