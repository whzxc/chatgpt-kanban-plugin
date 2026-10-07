#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("mcp") => chatgpt_kanban_plugin::plugin::stdio().await,
        Some("serve") => chatgpt_kanban_plugin::runtime::serve().await,
        _ => Err("Usage: chatgpt-kanban mcp | --version".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
