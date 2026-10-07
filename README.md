# ChatGPT Kanban Plugin

ChatGPT Desktop 内的独立看板插件。MIT 开源，支持 Apple Silicon macOS 与 Windows x64。

- 四列看板：待办、进行中、待审核、已完成；支持拖动排序、搜索、筛选和归档恢复。
- 卡片包含说明、项目目录、标签、截止日期和检查清单。
- 关联本机 Agent 任务，读取当前任务状态和输出；通过执行弹窗确认后创建或继续任务。
- 原生读取已安装 Agent 的配置和登录。外部 Agent 仍需各自的运行环境。

不需要 Connector App 或 Usage 插件。本仓库不包含用量面板、Tunnel、订阅管理、桌面更新或本地 ZIP 自动同步。

## 开发

需要 Node.js 24.12+ 和稳定版 Rust。

```sh
npm ci
npm run check
npm run check:format
npm run dev
```

浏览器预览地址为 `http://127.0.0.1:5189/plugin.html`，使用真实 Rust 后端，数据隔离在 `dist/dev-state`。前端支持热更新，Rust 修改后重启。`npm run plugin:dev` 可通过已安装宿主的 CLI 注册独立开发市场，资源通过 MCP 热更新。

```sh
npm run plugin:build
```

在对应平台构建原生插件 ZIP，并运行既有产物检查。无需 Node 或 Rust 即可使用打包后的插件。

## 安装与分发

插件标识为 `kanban@chatgpt-kanban`。源码在 `main`，双平台市场目录由发布工作流生成在同仓库 `stable` 分支；无需单独维护市场仓库。首次正式发布前可使用 Actions 的平台包或本地构建产物。参见 [分发](docs/distribution.md)。

## 数据与运行时

默认数据目录为 macOS 的 `~/.local/state/chatgpt-kanban-plugin` 或 Windows 的 `%LOCALAPPDATA%/chatgpt-kanban-plugin`，可通过 `CHATGPT_KANBAN_STATE_DIR` 覆盖。看板存于 `kanban.json`，任务回执、Agent 状态和执行输出也归本插件所有。不会自动读取或迁移 Connector 的私有状态。

MCP stdio 入口连接本插件的原生后台进程。操作系统文件锁保证同一目录只有一个写入者，卡片 revision 拒绝过期修改；执行前持久化请求标识，重试复用同一请求。后台只监听带随机令牌的本机回环地址，并拒绝浏览器 Origin。最后一个插件入口断开后后台自动退出，未完成操作按现有回执机制标为待确认；外部 Desktop 拥有的任务仍由宿主管理。

面板工具仅对 app 可见：`kanban`、`kanban_update`、`kanban_execute`、`agents`、`agent_tasks`、`agent_read`。此插件不向模型暴露通用 Agent 控制目录。

任务执行集成沿用原生 Agent 驱动，需要可用的本机 Agent；看板可在没有 Agent 时独立使用。卡片列由用户管理，任务结束不会自动移动卡片。

[Usage 插件](https://github.com/whzxc/chatgpt-usage-plugin) 独立维护两个用量面板。两个插件可分别安装、构建和发布。
