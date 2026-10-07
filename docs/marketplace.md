# ChatGPT Kanban marketplace

Installable Kanban board and linked Agent task controls for ChatGPT Desktop, with native Apple Silicon macOS and Windows x64 backends.

```sh
codex plugin marketplace add whzxc/chatgpt-kanban-plugin --ref stable
codex plugin add kanban@chatgpt-kanban
```

Update with `codex plugin marketplace upgrade chatgpt-kanban`, then reload the plugin and reopen the board. The host controls installation and its cache. Existing processes keep their previous binary until reloaded.

This branch is generated. Source, development documentation and issues live on [main](https://github.com/whzxc/chatgpt-kanban-plugin/tree/main). `release.json` identifies the source commit, version and binary SHA-256 hashes. Platform ZIPs and checksums are attached to [releases](https://github.com/whzxc/chatgpt-kanban-plugin/releases). Packages are not notarized macOS apps or Authenticode-signed Windows installers.

MIT licensed. No Connector Desktop, Node/npm runtime or Tunnel is required. This plugin manages work cards and linked Agent tasks. Task execution requires an explicit action in the panel.
