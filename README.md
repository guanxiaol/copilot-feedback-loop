<div align="center">

# Copilot Feedback Loop

### 拦截 GPT-4o / Claude Sonnet / Gemini — 让每一个 AI 动作都先过你这关

### Intercept GPT-4o / Claude Sonnet / Gemini — Every AI Action, Your Approval First

**Copilot Free 即可免费使用 GPT-4o / Claude Sonnet / Gemini 前沿御三家模型<br>本扩展让你掌控与它们的每一次交互——审阅、修改、重定向，一个不漏。**

**Frontier models (GPT-4o · Claude Sonnet · Gemini) are free via Copilot Free tier.<br>This extension gives you full control over every single interaction with them.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.99-blue.svg)](https://code.visualstudio.com/)
[![MCP](https://img.shields.io/badge/Protocol-MCP%20(Model%20Context%20Protocol)-purple.svg)](https://modelcontextprotocol.io/)
[![Models](https://img.shields.io/badge/Models-GPT--4o%20%7C%20Claude%20%7C%20Gemini-orange.svg)](#architecture)
[![AI Safety](https://img.shields.io/badge/AI%20Safety-Human--in--the--Loop-red.svg)](#what-is-this)

[English](#what-is-this) | [中文](#这是什么)

</div>

---

## What is This?

In VS Code's Copilot Chat **Agent mode**, frontier models like **GPT-4o**, **Claude Sonnet**, and **Gemini** autonomously read/write your files, run terminal commands, and make decisions — often before you even realize what happened.

**Feedback Loop MCP** injects a human checkpoint into the Agent's reasoning loop. Before every response, the Agent is **forced to pause**, display its full intended reply in a dedicated panel, and **wait for your approval, edits, or redirection**.

> Think of it as a **pull request review — but for every single AI action**, in real-time.

### Why You Need This

- **Copilot Agent is powerful but uncontrollable** — it can mass-edit files, run `rm -rf`, or refactor your entire codebase in one go. One hallucination = hours of cleanup.
- **You're paying for frontier models** (GPT-4o / Claude / Gemini) through your Copilot subscription — this tool ensures you actually **direct** how they work on your code, not just watch.
- **MCP is the new standard** — this is a production-ready reference implementation of the [Model Context Protocol](https://modelcontextprotocol.io/) for VS Code, with full source code and a [921-line architecture doc](docs/ARCHITECTURE.md).

### How It Works (30-second version)

1. This extension registers an MCP tool called `interactive_feedback`
2. The tool's description is injected into the Agent's system prompt, instructing it: _"You **MUST** call this tool before every response"_
3. When the Agent calls the tool, your reply is displayed in a Webview panel
4. The tool **blocks** until you type feedback and hit send
5. Your feedback becomes the tool result — the Agent reads it and continues

**No Copilot source code is modified.** This works entirely through VS Code's public Extension API and the open [Model Context Protocol](https://modelcontextprotocol.io/).

---

## Key Features

| Feature | Description |
| --- | --- |
| **Every-turn interception** | Agent must get human approval before each response |
| **Live Markdown preview** | See the Agent's full draft reply rendered in real-time |
| **Image support** | Paste screenshots as feedback; dual-path delivery for vision/non-vision models |
| **Audio alerts** | 4 synthesized notification sounds (Web Audio API, zero audio files) |
| **Sidebar dashboard** | Live connection status, port, session ID, request stats |
| **One-click toggle** | Enable/disable interception without restarting |
| **100% local** | Zero network requests, zero telemetry, zero license checks |
| **Zero external deps** | MCP child process uses VS Code's built-in Electron runtime — no Node.js install required |

---

## Architecture

```text
┌──────────────────────────┐
│   Copilot Chat (Agent)   │  VS Code Chat participant
│   system prompt + tools  │
└────────────┬─────────────┘
             │ (1) stdio JSON-RPC (MCP)
             ▼
┌──────────────────────────┐
│   MCP Child Process      │  ELECTRON_RUN_AS_NODE=1
│   out/mcp/server.js      │  @modelcontextprotocol/sdk + zod
└────────────┬─────────────┘
             │ (2) TCP 127.0.0.1:<random port>  NDJSON
             ▼
┌──────────────────────────┐
│   Extension Host         │  out/extension.js
│   IpcServer · Panel · UI │
└────────────┬─────────────┘
             │ (3) postMessage
             ▼
┌──────────────────────────┐
│   Webview Panel          │  Feedback UI + Dashboard
│   media/panel.{css,js}   │
└──────────────────────────┘
```

Three communication layers: **MCP stdio** → **TCP IPC** → **VS Code postMessage**

> For the full 13-section deep-dive (process topology, port discovery, prompt hijacking mechanics, sequence diagrams, image handling, security model), see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Quick Start

```bash
# Clone
git clone https://github.com/guanxiaol/copilot-feedback-loop.git
cd copilot-feedback-loop

# Build
npm install
npm run build

# Package & Install
npm run package
code --install-extension feedback-loop-mcp.vsix --force
```

Or: Extensions view → `···` → **Install from VSIX...**

### First Run

1. Check the **activity bar** — a new "Feedback Loop MCP" icon should appear
2. Open **Copilot Chat** → switch to **Agent mode**
3. Ask anything — the Agent will call `interactive_feedback` before replying
4. **Review, edit, or redirect** in the feedback panel → hit Send
5. Type `done`, `end`, `结束`, `停止`, or `拜拜` to end the loop

---

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `feedback-loop.autoOpenPanel` | boolean | `true` | Auto-open feedback panel on new request |
| `feedback-loop.maximizePanel` | boolean | `true` | Maximize editor group when panel opens |
| `feedback-loop.flashTaskbar` | boolean | `true` | Bring window to front on new request |
| `feedback-loop.ctrlEnterSend` | boolean | `true` | `true` = Ctrl/Cmd+Enter to send; `false` = Enter to send |
| `feedback-loop.soundEnabled` | boolean | `true` | Play notification sound |
| `feedback-loop.soundType` | enum | `chime` | `triple` / `chime` / `ping` / `urgent` / `none` |

---

## Commands

| Command | Description |
| --- | --- |
| `Feedback Loop: Open Panel` | Manually open the feedback panel |
| `Feedback Loop: Restart MCP` | Restart IPC Server with new port & session |
| `Feedback Loop: Toggle` | Enable / disable interception |
| `Feedback Loop: Reset Stats` | Reset request count & average latency |

---

## Requirements

| Dependency | Version |
| --- | --- |
| **VS Code** | ≥ 1.99 (`mcpServerDefinitionProviders` API) |
| **GitHub Copilot Chat** | Installed & signed in (Agent mode) |
| **Node.js** (build only) | ≥ 18 |

> **Note:** Designed for **native VS Code + GitHub Copilot Chat**. Forks like Cursor / Windsurf / Trae can load the extension, but lack the `mcpServerDefinitionProviders` API for auto-registration.

---

## Known Limitations

| Issue | Detail |
| --- | --- |
| Prompt-level constraint | Models may occasionally ignore the "must call" rule — inherent to description-based enforcement |
| No TCP auth | Other local processes could theoretically connect to `127.0.0.1`; HMAC handshake can be added |
| VS Code only | Forks don't support the required MCP provider API |
| Chinese-only UI | Not yet wired to `vscode-nls` |
| No image cleanup | Temp images in `os.tmpdir()` rely on OS-level cleanup |

---

## Contributing

Contributions, issues, and feature requests are welcome!

1. Fork the repo
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## Disclaimer

This project is published for **technical research and educational purposes only**.

1. **Research purpose** — All code, documentation, and architecture are shared to help developers understand how the MCP protocol works, and how VS Code extensions interact with the Copilot Chat Agent.
2. **No reverse engineering** — This project does **not** modify, crack, or reverse-engineer any GitHub Copilot source code or binaries. It works entirely through VS Code's public Extension API (`vscode.lm.registerMcpServerDefinitionProvider`) and the open MCP specification.
3. **No warranty** — The software is provided "as is", without warranty of any kind. The author is not liable for any damages arising from its use.
4. **Compliance** — Users are responsible for ensuring their usage complies with GitHub Copilot's Terms of Service, local laws, and organizational policies.
5. **Data privacy** — This extension runs 100% locally. No data is collected, transmitted, or stored on external servers. User feedback and images travel only between local VS Code processes. Data subsequently processed by Copilot is subject to GitHub's own data policies, not this project's.

---

<br>

<div align="center">

---

# 中文文档

</div>

## 这是什么？

VS Code 1.99+ 的 Copilot Chat Agent 模式下，**GPT-4o**、**Claude Sonnet**、**Gemini** 等前沿模型会自主读写你的文件、执行终端命令——大多数时候你只能**事后**审查结果。

**Feedback Loop MCP** 在 Agent 的推理循环中插入了一个「人类关卡」：Agent 每次准备回复时，必须先调用 `interactive_feedback` 工具，把即将发出的完整回复展示在 Webview 面板中，等你审阅、修改或补充后才继续。

> 你可以把它理解为：**对 AI 每一步操作的实时 Code Review。**

### 为什么你需要它

- **Copilot Agent 强大但不可控** — 它能批量改文件、跑 `rm -rf`、一口气重构整个代码库。一次幻觉 = 几小时返工。
- **你在为前沿模型付费**（GPT-4o / Claude / Gemini 都在 Copilot 订阅里）— 这个工具确保你真正**指挥**它们干活，而不是干看着。
- **MCP 是新一代标准** — 这是 [Model Context Protocol](https://modelcontextprotocol.io/) 在 VS Code 上的生产级参考实现，附完整源码和 [921 行架构深度文档](docs/ARCHITECTURE.md)，是学习 MCP 协议的最佳起点。

### 原理（30 秒版）

1. 扩展注册一个 MCP 工具 `interactive_feedback`
2. 工具的 `description` 被注入 Agent 的 system prompt，指令为：_"你**必须**在每次回复前调用此工具"_
3. Agent 调用工具时，其完整回复草稿展示在 Webview 面板
4. 工具会**阻塞等待**，直到你输入反馈并点击发送
5. 你的反馈作为工具返回值，Agent 读取后继续推理

**不修改 Copilot 源码。** 完全通过 VS Code 公开的 Extension API 和开放的 [Model Context Protocol](https://modelcontextprotocol.io/) 实现。

---

## 核心功能

| 功能 | 说明 |
| --- | --- |
| **每轮拦截** | Agent 的每次回复都必须先经过人类审阅 |
| **Markdown 预览** | 面板内实时渲染 Agent 即将发出的完整回复 |
| **图片支持** | 粘贴图片作为反馈，base64 编码 + 本地落盘，兼容 vision / 非 vision 模型双路传输 |
| **音效提醒** | 4 种 Web Audio 合成提示音，无外部音频文件依赖 |
| **侧边栏控制台** | 实时显示连接状态、端口、会话 ID、请求统计 |
| **一键启停** | 启用/停用拦截，停用时自动放行不打断 Agent |
| **完全本地** | 零网络请求、零遥测、零 license 校验 |
| **零外部依赖** | MCP 子进程使用 VS Code 内置 Electron 运行时，无需安装 Node.js |

---

## 快速开始

```bash
# 克隆
git clone https://github.com/guanxiaol/copilot-feedback-loop.git
cd copilot-feedback-loop

# 构建
npm install
npm run build

# 打包 & 安装
npm run package
code --install-extension feedback-loop-mcp.vsix --force
```

或在 VS Code 中：扩展视图 → 右上角 `···` → **从 VSIX 安装...**

### 首次使用

1. 检查左侧活动栏 — 应出现「反馈回路 MCP」图标
2. 打开 **Copilot Chat** → 切换到 **Agent 模式**
3. 正常提问 — Agent 在回复前会自动调用 `interactive_feedback`，弹出反馈面板
4. 在面板中**审阅、修改或补充** → 点击发送
5. 输入 `done`、`end`、`结束`、`停止` 或 `拜拜` 结束循环

---

## 配置项

| 设置 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `feedback-loop.autoOpenPanel` | boolean | `true` | 收到请求时自动打开反馈面板 |
| `feedback-loop.maximizePanel` | boolean | `true` | 面板打开时最大化编辑器组 |
| `feedback-loop.flashTaskbar` | boolean | `true` | 收到请求时把窗口带到前台 |
| `feedback-loop.ctrlEnterSend` | boolean | `true` | `true` = Ctrl/⌘+Enter 发送；`false` = Enter 发送 |
| `feedback-loop.soundEnabled` | boolean | `true` | 收到请求时播放提示音 |
| `feedback-loop.soundType` | enum | `chime` | `triple` / `chime` / `ping` / `urgent` / `none` |

---

## 命令面板

| 命令 | 说明 |
| --- | --- |
| `反馈回路：打开反馈面板` | 手动打开反馈面板 |
| `反馈回路：重启 MCP 服务` | 重启 IPC Server，生成新端口和会话 ID |
| `反馈回路：启用 / 停用拦截器` | 切换拦截状态（停用后自动放行） |
| `反馈回路：重置统计数据` | 清零请求计数和平均耗时 |

---

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| **VS Code** | ≥ 1.99（需 `mcpServerDefinitionProviders` API） |
| **GitHub Copilot Chat** | 已安装并登录（Agent 模式） |
| **Node.js**（仅构建时需要） | ≥ 18 |

> ⚠️ 本扩展专为 **原生 VS Code + GitHub Copilot Chat** 设计。Cursor / Windsurf / Trae 等分叉虽能安装，但不支持自动注册 MCP 工具。

---

## 深度文档

完整的 13 节技术文档见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，涵盖：

- MCP 协议与 VS Code 集成机制
- 进程拓扑与生命周期
- TCP IPC 通道设计（为何不用 stdio / Unix socket）
- 端口发现的三条冗余路径
- Tool description 如何「劫持」Agent 意图
- 完整反馈循环时序图
- 图片处理的 vision / 非 vision 双发方案
- Webview 前后端通信与 UI 状态机
- 安全模型分析

---

## 已知局限

| 项 | 说明 |
| --- | --- |
| Prompt 劫持非确定性 | 模型可能忽略 description 中的强制规则（prompt 约束的固有局限） |
| TCP 无鉴权 | `127.0.0.1` 上其他本地进程理论上可连接；可通过 HMAC 校验增强 |
| 仅适用原生 VS Code | Cursor / Windsurf / Trae 不支持 `mcpServerDefinitionProviders` API |
| 无国际化框架 | UI 字符串硬编码中文，暂未接入 `vscode-nls` |
| 临时图片无自动清理 | 落盘在 `os.tmpdir()/feedback-loop-mcp/images/`，依赖 OS 级清理 |

---

## 免责声明

本项目为**纯技术研究与公开**，旨在探索 VS Code MCP 协议集成机制及 AI Agent 的 human-in-the-loop 控制方案。

1. **技术探索目的** — 全部代码、文档和架构设计仅用于学习、研究和技术交流。通过公开实现细节，帮助开发者理解 MCP 协议的工作方式以及 VS Code 扩展与 Copilot Chat Agent 的交互机制。

2. **无恶意用途** — 本项目不修改、不破解、不逆向任何 GitHub Copilot 的源码或二进制文件。完全通过 VS Code 公开的 Extension API (`vscode.lm.registerMcpServerDefinitionProvider`) 和 MCP 开放协议实现，不涉及任何非授权的系统访问。

3. **无担保** — 本软件按「原样」提供，不提供任何形式的明示或暗示担保。作者不对使用本软件产生的任何直接或间接损害承担责任。

4. **合规使用** — 使用者应自行确保其使用方式符合 GitHub Copilot 的服务条款、所在地区的法律法规及所属组织的合规要求。

5. **数据隐私** — 本扩展完全本地运行，不收集、不传输、不存储任何用户数据到外部服务器。用户的反馈文本和图片仅在本地 VS Code 进程间传递，最终作为 MCP tool result 返回给 Copilot — 该数据的后续处理取决于 GitHub Copilot 自身的数据策略，与本项目无关。

---

<div align="center">

## License / 许可证

[MIT](LICENSE) — Free to use, modify, and distribute.

自由使用、修改和分发。

<br>

**If this project helps you, consider giving it a ⭐**

**如果这个项目对你有帮助，欢迎点个 ⭐ 支持一下**

</div>
