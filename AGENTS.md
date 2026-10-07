# 开发约定

- MIT；本仓库仅维护 ChatGPT Desktop Kanban 插件及同仓库市场分发。
- 不依赖 Connector App 或 Usage 插件，不包含 Tunnel、订阅或桌面更新。
- 支持 macOS 和 Windows；Rust 原生运行时，React 面板，Node 仅用于开发构建。
- 不使用 Git worktree，不新增测试文件或用例；运行已有检查和真实验收。
- 公开推送和发布须由用户授权。提交使用单行 `type(scope): 中文说明`。
- 不提交私有路径、账号、密钥或真实任务数据。
- 单选复用 SingleChoice，弹窗复用 Dialog，主题复用 tokens.css 与 theme.ts。
- 文档仅描述当前架构、功能、限制和操作方法。
