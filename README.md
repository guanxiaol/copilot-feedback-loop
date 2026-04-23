# Feedback Loop MCP — Copilot Chat 人机反馈拦截器

> 一个完全本地、MIT 开源的 VS Code 扩展，通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 强制 GitHub Copilot Chat Agent **在每次回复前暂停，等待人类审阅与反馈**。

---

## 它解决什么问题？

VS Code 1.99+ 的 Copilot Chat Agent 模式下，AI 会自主读写文件、执行终端命令。大多数时候你只能在事后审查结果。

**Feedback Loop MCP** 在 Agent 的推理循环中插入了一个"人类关卡"：Agent 每次准备回复时，必须先调用 `interactive_feedback` 工具，把即将发出的完整回复展示在 Webview 面板中，等你审阅、修改或补充后才继续。

核心原理：利用 MCP 协议将工具的 `description`（即 prompt 指令）注入 Agent 的 system prompt，让模型**自愿遵守**"每次回复前必须调用"的规则。这不是修改 Copilot 源码，而是**通过协议层面合法地施加行为约束**。

---

## 架构总览

```
+--------------------------+
|   Copilot Chat (Agent)   |  ← VS Code 渲染进程 / Chat participant
|   system prompt 含 tools |
+------------+-------------+
             |
             |  (1) stdio JSON-RPC (MCP 协议)
             v
+--------------------------+
|   MCP 子进程             |  ← process.execPath + ELECTRON_RUN_AS_NODE=1
|   out/mcp/server.js      |     无需用户安装 Node，用 VS Code 内置运行时
|   @modelcontextprotocol  |
|     /sdk + zod           |
+------------+-------------+
             |
             |  (2) TCP 127.0.0.1:<随机端口>  行分隔 JSON (NDJSON)
             v
+--------------------------+
|   VS Code Extension Host |  ← 扩展宿主 Node 进程
|   out/extension.js       |
|   - IpcServer (net)      |
|   - FeedbackPanel (UI)   |
|   - DashboardProvider    |
|   - McpServerDefProvider |
+------------+-------------+
             |
             |  (3) postMessage / onDidReceiveMessage
             v
+--------------------------+
|   WebviewPanel (UI)      |  ← 反馈面板 + 侧边栏控制台
|   media/panel.{css,js}   |
+--------------------------+
```

**三条通信链路**：
1. **Copilot ↔ MCP 子进程**：标准 MCP stdio JSON-RPC，由 `@modelcontextprotocol/sdk` 处理
2. **MCP 子进程 ↔ 扩展宿主**：TCP `127.0.0.1` 随机端口，NDJSON 帧格式，自建 IPC
3. **扩展宿主 ↔ Webview**：VS Code 原生 `postMessage` API

---

## 功能特性

- **每轮拦截**：Agent 的每次回复都必须先经过人类审阅
- **Markdown 预览**：面板内实时渲染 Agent 即将发出的完整回复
- **图片支持**：支持粘贴图片作为反馈，自动 base64 编码 + 本地落盘，兼容 vision / 非 vision 模型的双路传输
- **音效提醒**：4 种 Web Audio 合成提示音（triple / chime / ping / urgent），无外部音频依赖
- **侧边栏控制台**：实时显示连接状态、端口、会话 ID、请求统计
- **启停开关**：一键启用/停用拦截，停用时自动放行不打断 Agent
- **完全本地**：零网络请求、零遥测、零 license 校验
- **零外部依赖**：MCP 子进程使用 VS Code 内置 Electron 运行时，不要求用户安装 Node.js

---

## 环境要求

| 依赖 | 版本 |
|---|---|
| **VS Code** | ≥ 1.99（需要 `mcpServerDefinitionProviders` API） |
| **GitHub Copilot Chat** | 已安装并登录（提供 Agent 模式） |
| **Node.js**（仅构建时需要） | ≥ 18 |

> ⚠️ 本扩展专为 **原生 VS Code + GitHub Copilot Chat** 设计。Cursor / Windsurf / Trae 等 VS Code 分叉虽能安装，但不支持 `mcpServerDefinitionProviders` API，MCP 工具无法自动注册。

---

## 构建 & 安装

```bash
# 1. 安装依赖
npm install

# 2. 构建（esbuild 同时产出 extension.js 和 mcp/server.js）
npm run build

# 3. 打包 VSIX
npm run package          # → feedback-loop-mcp.vsix

# 4. 安装到 VS Code
code --install-extension feedback-loop-mcp.vsix --force
```

或者在 VS Code 中：扩展视图 → 右上角 `···` → **Install from VSIX...**

---

## 使用方法

1. **确认扩展已激活**：左侧活动栏出现"反馈回路 MCP"图标，点击可查看控制台面板
2. **打开 Copilot Chat**：切换到 **Agent 模式**（不是普通 Chat 模式）
3. **正常提问**：Agent 在生成回复前会自动调用 `interactive_feedback`，弹出反馈面板
4. **审阅 & 反馈**：在面板中查看 Agent 即将发出的回复，输入反馈后点击发送
5. **结束对话**：在反馈中输入 `done`、`end`、`结束`、`停止` 或 `拜拜`，Agent 将停止循环

---

## 配置项

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `feedback-loop.autoOpenPanel` | boolean | `true` | 收到请求时自动打开反馈面板 |
| `feedback-loop.maximizePanel` | boolean | `true` | 面板打开时最大化编辑器组 |
| `feedback-loop.flashTaskbar` | boolean | `true` | 收到请求时把窗口带到前台 |
| `feedback-loop.ctrlEnterSend` | boolean | `true` | `true` = Ctrl/⌘+Enter 发送；`false` = Enter 直接发送 |
| `feedback-loop.soundEnabled` | boolean | `true` | 收到请求时播放提示音 |
| `feedback-loop.soundType` | enum | `chime` | `triple` / `chime` / `ping` / `urgent` / `none` |

---

## 命令面板

| 命令 | 说明 |
|---|---|
| `反馈回路：打开反馈面板` | 手动打开反馈面板 |
| `反馈回路：重启 MCP 服务` | 重启 IPC Server，生成新端口和会话 ID |
| `反馈回路：启用 / 停用拦截器` | 切换拦截状态（停用后自动放行） |
| `反馈回路：重置统计数据` | 清零请求计数和平均耗时 |

---

## 工作原理详解

完整的 13 节技术深度文档见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，涵盖：

- MCP 协议与 VS Code 集成机制
- 进程拓扑与生命周期
- TCP IPC 通道设计（为何不用 stdio / Unix socket）
- 端口发现的三条冗余路径
- Tool description 如何"劫持"Agent 意图
- 完整反馈循环时序图
- 图片处理的 vision / 非 vision 双发方案
- Webview 前后端通信与 UI 状态机
- 安全模型分析

---

## 已知局限

| 项 | 说明 |
|---|---|
| Prompt 劫持非确定性 | 模型可能忽略 description 中的强制规则（prompt-level 约束的固有局限） |
| TCP 无鉴权 | `127.0.0.1` 上其他本地进程理论上可连接；可通过 HMAC 校验 hello 增强 |
| 仅适用于原生 VS Code | Cursor / Windsurf / Trae 等分叉不支持 `mcpServerDefinitionProviders` API |
| 无国际化框架 | UI 字符串硬编码中文，暂未接入 `vscode-nls` |
| 临时图片无自动清理 | 落盘在 `os.tmpdir()/feedback-loop-mcp/images/`，依赖 OS 级清理 |

---

## 免责声明

本项目为**纯技术研究与公开**，旨在探索 VS Code MCP 协议集成机制及 AI Agent 的 human-in-the-loop 控制方案。

1. **技术探索目的**：本项目的全部代码、文档和架构设计仅用于学习、研究和技术交流。通过公开实现细节，帮助开发者理解 MCP 协议的工作方式、VS Code 扩展与 Copilot Chat Agent 的交互机制。

2. **无恶意用途**：本项目不修改、不破解、不逆向任何 GitHub Copilot 的源码或二进制文件。它完全通过 VS Code 公开的 Extension API (`vscode.lm.registerMcpServerDefinitionProvider`) 和 MCP 开放协议实现功能，不涉及任何非授权的系统访问。

3. **无担保**：本软件按"原样"提供，不提供任何形式的明示或暗示担保。作者不对使用本软件产生的任何直接或间接损害承担责任。

4. **合规使用**：使用者应自行确保其使用方式符合 GitHub Copilot 的服务条款、所在地区的法律法规，以及所属组织的合规要求。

5. **数据隐私**：本扩展完全本地运行，不收集、不传输、不存储任何用户数据到外部服务器。用户的反馈文本和图片仅在本地 VS Code 进程间传递，最终作为 MCP tool result 返回给 Copilot —— 该数据的后续处理取决于 GitHub Copilot 自身的数据策略，与本项目无关。

---

## 许可证

[MIT License](LICENSE) — 自由使用、修改和分发。
