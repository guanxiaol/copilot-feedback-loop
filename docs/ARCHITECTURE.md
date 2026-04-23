# Feedback Loop MCP · 原理与实现

一份面向插件开发者 / 逆向研究者的"把每一根线都拆到能看见"的技术文档。
读完你应该能：

- 复述 VS Code Copilot Chat Agent 是如何被"拦截"的。
- 画出从 Agent 发出 `tools/call` 到用户在 Webview 点"发送"再回到 Agent 的完整时序。
- 在不看代码的情况下，说出每一个进程、每一条 socket 的生命周期。
- 从零复刻这个扩展、或把它改造成你自己需要的 human-in-the-loop 控制面。

全文分 13 节。文件路径均为相对仓库根 `feedback-loop-mcp/` 的路径。

---

## 目录

1. [我们到底在"拦截"什么](#1-我们到底在拦截什么)
2. [MCP 协议快速入门](#2-mcp-协议快速入门)
3. [整体架构与进程拓扑](#3-整体架构与进程拓扑)
4. [生命周期：从 VS Code 启动到 Agent 调用](#4-生命周期从-vs-code-启动到-agent-调用)
5. [注册 MCP Server：`registerMcpServerDefinitionProvider`](#5-注册-mcp-serverregistermcpserverdefinitionprovider)
6. [子进程 IPC 通道：TCP + 行分隔 JSON](#6-子进程-ipc-通道tcp--行分隔-json)
7. [端口发现：三条路径的冗余设计](#7-端口发现三条路径的冗余设计)
8. [Tool 描述如何"劫持"Agent 的意图](#8-tool-描述如何劫持-agent-的意图)
9. [完整反馈循环时序](#9-完整反馈循环时序)
10. [图片处理：vision 模型与非 vision 模型的双发](#10-图片处理vision-模型与非-vision-模型的双发)
11. [Webview 前后端通信](#11-webview-前后端通信)
12. [命令、配置项、UI 状态机](#12-命令配置项ui-状态机)
13. [构建、打包、分发与已知局限](#13-构建打包分发与已知局限)

---

## 1. 我们到底在"拦截"什么

VS Code 自 1.99 起为 Copilot Chat 提供了 Model Context Protocol（MCP）集成。第三方扩展可以把自己注册成 Copilot Agent 会调用的外部工具服务。

Copilot Agent 在推理每一轮时，会把**所有已注册 MCP server 暴露的工具**列表 + 每个工具的 `description` 字段一并放进它的 system prompt，交给底层大模型。模型随后自行决定：

- 这一轮是直接回复用户；
- 还是先调某个工具 `tools/call`，拿到返回内容作为观察再继续思考。

**"拦截"的本质是：向 Agent 提供一个名为 `interactive_feedback` 的工具，并通过它的 description 把调用义务写成硬性规则。**

description 里有一条关键句（参见 `src/mcp/server.ts` 中的 `TOOL_DESC`）：

> 1. You MUST call this tool before EVERY response.
> 3. Wait for user feedback before continuing.
> 4. Only stop when the USER's feedback contains: `"end"`, `"done"`, `"结束"`, `"停止"`, `"拜拜"`.

这条"description 即 prompt"的约束让模型**自愿**在每次即将回复前先调工具。工具内部不是立刻返回结果，而是把即将回复的内容转发到 VS Code 侧的 Webview 面板，等待用户键入反馈后才返回。Agent 拿到反馈后继续推理：用户可能要求"继续"、"改成 X"、"再加 Y"，形成**每轮都有人类参与审阅**的循环。

这不是"无代码修改就拦截 Agent"，而是**利用 MCP 协议把自己塞进 Agent 的 system prompt**，通过指令约束达成"强制人机交互"。模型配合即成功，模型不配合（忽略 description）理论上可绕过，但主流模型在清晰且冗余写明的规则下会遵守。

---

## 2. MCP 协议快速入门

Model Context Protocol 是 Anthropic 主导的开放协议，用 **JSON-RPC 2.0** 在"客户端"（模型宿主，如 Claude Desktop / VS Code Copilot Chat）与"服务端"（工具提供方）之间通信。

协议核心概念：

| 概念 | 含义 |
|---|---|
| **Transport** | 最常用 `stdio`（子进程 stdin/stdout 传输）、`streamable-http`、自定义 socket。Copilot Chat 目前主用 stdio。|
| **Server** | 对外暴露 Tools / Resources / Prompts 的服务端。|
| **Tool** | 一个带 `name` / `description` / `inputSchema` / `handler` 的可调用函数。|
| **Request** | `initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`, ... |
| **Content Block** | Tool 返回结果的基本单位：`text` / `image` / `resource` / `audio` 等。|

一次 `tools/call` 的完整 JSON-RPC 报文（示例，实际由 `@modelcontextprotocol/sdk` 自动生成）：

```json
// --> 客户端发出
{
  "jsonrpc": "2.0", "id": 42, "method": "tools/call",
  "params": {
    "name": "interactive_feedback",
    "arguments": { "summary": "### 我打算修改这 3 个文件..." }
  }
}

// <-- 服务端返回
{
  "jsonrpc": "2.0", "id": 42,
  "result": {
    "content": [
      { "type": "text",  "text": "帮我把第 2 个文件改成 async/await" },
      { "type": "image", "mimeType": "image/png", "data": "<base64>" }
    ]
  }
}
```

本项目依赖官方 SDK `@modelcontextprotocol/sdk`，因此只管 tool 注册与 handler 逻辑，不手写 JSON-RPC 解析。

---

## 3. 整体架构与进程拓扑

```
+--------------------------+
|   Copilot Chat (Agent)   |  ← VS Code 渲染进程里的 Chat participant
|   system prompt 含 tools |
+------------+-------------+
             |
             |  (1) stdio JSON-RPC (MCP)
             v
+--------------------------+
|   MCP 子进程             |   ← process.execPath + ELECTRON_RUN_AS_NODE=1
|   out/mcp/server.js      |      跑我们打包后的 Node 脚本
|   @modelcontextprotocol  |
|     /sdk + zod           |
+------------+-------------+
             |
             |  (2) TCP 127.0.0.1:<随机端口>  行分隔 JSON
             v
+--------------------------+
|   VS Code Extension Host |   ← 扩展宿主 Node 进程（不是渲染进程）
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
|   WebviewPanel (UI)      |   ← 渲染进程内的 iframe-like webview
|   media/panel.{html,js}  |
+--------------------------+
```

进程数量：

- **A. VS Code 主进程**（图中未画）：仅负责窗口/Chat UI。
- **B. Extension Host**：我们扩展的主代码运行在这里。单一。
- **C. MCP 子进程**：Copilot 启动的 stdio 子进程。**每一次会话 / 重启扩展可能有 0~N 个**；由 Copilot Chat 决定何时起、何时止。
- **D. Webview 渲染**：Webview View（侧边栏 dashboard）和 WebviewPanel（反馈面板）各是一个 DOM 上下文，属于渲染进程但和用户写的网页一样，只能通过 `postMessage` 跟 B 通信。

关键是：**A ↔ B ↔ D 都是 VS Code 提供的机制，C 是我们自己新起的 Node 子进程，B 和 C 之间需要我们自建通道**——这正是 TCP IPC 的由来。

---

## 4. 生命周期：从 VS Code 启动到 Agent 调用

按时间顺序，拆成 9 步：

1. **扩展激活**
   `activate()` 在 `onStartupFinished` 触发。
2. **Dashboard 注册**
   `vscode.window.registerWebviewViewProvider('feedback-loop.dashboard', provider)`。
3. **IPC Server 启动**
   监听 `127.0.0.1:0`（`0` 让 OS 分配空闲端口），随机端口落盘为 `<sessionId>.port`。
4. **MCP Server Definition Provider 注册**
   `vscode.lm.registerMcpServerDefinitionProvider(id, provider)`。该 provider 的 `provideMcpServerDefinitions()` 返回一个 `McpStdioServerDefinition`，包含 `command=process.execPath`、`args=[out/mcp/server.js 绝对路径]`、`env={ELECTRON_RUN_AS_NODE:1, FEEDBACK_LOOP_IPC_PORT, FEEDBACK_LOOP_SESSION_ID, FEEDBACK_LOOP_PORT_DIR}`。
5. **Copilot Chat 读取 provider**
   用户在 Chat 面板里切到 Agent 模式 / 或 VS Code 启动 MCP server 发现时，Copilot 调 `provideMcpServerDefinitions()`，拿到定义后 spawn 一个子进程。
6. **子进程启动**
   进程入口是我们的 `out/mcp/server.js`。入口函数 `main()`：
   - 构造 `IpcClient`（不立刻连，惰性）
   - 构造 `McpServer`，调 `server.tool('interactive_feedback', ...)` 注册唯一工具
   - 连上 `StdioServerTransport`：从 stdin 读、往 stdout 写。
7. **握手**
   Copilot → 子进程发 `initialize`、`tools/list`。子进程返回工具清单。
8. **第一次 `tools/call`**
   当模型决定调用 `interactive_feedback`，Copilot 把请求写入子进程 stdin。
9. **Feedback 双跳**
   子进程调 `ipc.requestFeedback(summary)`：
   - 若 TCP 还未连，现在连到 `127.0.0.1:<env 提供的端口>`；
   - 写一条 `{ type: 'feedback_request', id, summary, timestamp }\n`；
   - 扩展宿主收到后 `postMessage` 给 WebviewPanel；
   - 用户点"发送"，Webview `postMessage` 回扩展宿主；
   - 扩展宿主把图片落盘、组装 `feedback_response`，写回 TCP；
   - 子进程读取响应、作为 `tools/call` 的 result 写回 stdout；
   - Copilot 解出 result 喂给模型继续推理。

关闭时（`deactivate` 或 VS Code 关闭）：
- IPC Server `close()`，所有客户端 socket 被 `destroy()`。
- `.port` 文件清理。
- 子进程是被 Copilot 通过 stdio close 通知关闭的——我们不主动杀它。

---

## 5. 注册 MCP Server：`registerMcpServerDefinitionProvider`

这是整个拦截的法定入口。没有它，我们的 `server.js` 不会被 Copilot 看见。

### 5.1 API 形态

VS Code 自 1.99 起在 `vscode.lm` 命名空间提供：

```ts
namespace lm {
  function registerMcpServerDefinitionProvider(
    id: string,
    provider: { provideMcpServerDefinitions(): McpServerDefinition[] | Thenable<McpServerDefinition[]> }
  ): Disposable;
}

class McpStdioServerDefinition {
  constructor(
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string>
  );
}
```

注意这是 **proposed API**，API 表面形状在不同版本略有差异，因此我们要做类型安全的兜底：

```ts
// src/extension/extension.ts
interface LmApi {
  registerMcpServerDefinitionProvider?: (id: string, provider: any) => vscode.Disposable;
}

interface McpStdioServerDefinitionCtor {
  new (label: string, command: string, args: string[], env: Record<string, string>): unknown;
}

const lm = (vscode as unknown as { lm?: LmApi }).lm;
const McpStdioServerDefinition = (vscode as unknown as { McpStdioServerDefinition?: McpStdioServerDefinitionCtor }).McpStdioServerDefinition;

if (lm?.registerMcpServerDefinitionProvider && McpStdioServerDefinition) {
  // 正常注册
} else {
  vscode.window.showWarningMessage('反馈回路：当前 VS Code 版本未暴露 MCP Server Provider API …');
}
```

即便 API 消失或改名，我们也只是降级成"只能手动打开面板"，不至于让 `activate()` 崩掉。

### 5.2 为什么用 `process.execPath + ELECTRON_RUN_AS_NODE=1`

`process.execPath` 就是当前 VS Code 的 Electron 可执行文件。设了 `ELECTRON_RUN_AS_NODE=1` 后，它会当成纯 Node 跑我们的脚本，不启动窗口 / 渲染栈。

好处：

- **不依赖用户本地安装 Node**。用户只要装得了 VS Code，就能跑我们的 MCP 服务端。
- **保证 Node 版本和扩展宿主一致**。宿主能跑的 JS 特性，子进程也能跑，不必为某个 Node 版本做兼容。

同等作用的其他方案：`node` / `npx` / `npm run`，都有依赖问题，最差；这是 VS Code 生态内最干净的做法。

### 5.3 注册点实现

```ts
// src/extension/extension.ts
const serverPath = path.join(context.extensionPath, 'out', 'mcp', 'server.js');
const disposable = lm.registerMcpServerDefinitionProvider('feedback-loop-mcp-provider', {
  provideMcpServerDefinitions: () => {
    const def = new McpStdioServerDefinition(
      '反馈回路 MCP',
      process.execPath,
      [serverPath],
      {
        ELECTRON_RUN_AS_NODE: '1',
        FEEDBACK_LOOP_IPC_PORT: String(ipcServer?.getPort() ?? 0),
        FEEDBACK_LOOP_SESSION_ID: ipcServer?.sessionId ?? '',
        FEEDBACK_LOOP_PORT_DIR: ipcServer?.portDir ?? ''
      }
    );
    return [def];
  }
});
context.subscriptions.push(disposable);
```

注意：`provideMcpServerDefinitions()` 可能被 Copilot **多次**调用（比如用户切换 Chat / 重新加载 MCP 列表）。每次我们都返回指向当前 `ipcServer` 端口的最新定义。这就是为什么 `ipcServer.start()` 必须在 provider 注册**之前**完成。

package.json 侧还要声明 contribution：

```json
"mcpServerDefinitionProviders": [
  { "id": "feedback-loop-mcp-provider", "label": "反馈回路 MCP" }
]
```

---

## 6. 子进程 IPC 通道：TCP + 行分隔 JSON

Copilot 和子进程之间是 stdio JSON-RPC；**扩展宿主 (B) 和子进程 (C) 之间**是我们自己的 TCP 通道。

### 6.1 为什么不是 stdio

子进程的 stdio 被 Copilot Chat 独占（它通过 stdin/stdout 跟子进程跑 MCP 协议），我们再往里掺别的消息会破坏 JSON-RPC。因此必须另开通道。

候选：

| 通道 | 优点 | 缺点 |
|---|---|---|
| TCP 127.0.0.1:随机端口 | 最简单，Node 内建 | 理论上同机器其他进程可连；防火墙偶尔干扰 |
| Unix domain socket / Windows Named Pipe | 更私密 | 跨平台 API 分裂，代码量上升 |
| 文件系统 fifo / 消息队列 | — | 性能差、边界情况多 |

我们选 TCP + 只绑 `127.0.0.1`。同机器其他用户理论上能连，但考虑到：
- 端口是运行时随机；
- Copilot 才是"第一个合法连接"，我们并不做身份验证，但也没有副作用超大的 API（仅限弹面板等反馈交互）；
- 如果要强化，可以加一个随机 token 校验 `hello` 消息。

### 6.2 帧格式：`\n` 分隔的 JSON

MCP 规范用 `Content-Length` 帧（HTTP 风格），但我们是内部通道，用更简单的 NDJSON（newline-delimited JSON）：

```
{"type":"feedback_request","id":"abc","summary":"...","timestamp":1700000000000}\n
{"type":"feedback_response","id":"abc","feedback":"..."}\n
```

对应实现：

```ts
// src/ipc/protocol.ts
export const MSG_DELIM = '\n';

export function encode(msg: IpcMsg): string {
  return JSON.stringify(msg) + MSG_DELIM;
}

export class LineDecoder {
  private buf = '';
  feed(chunk: string | Buffer, onMessage: (m: IpcMsg) => void): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf(MSG_DELIM)) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line) as IpcMsg); }
      catch { /* 丢掉坏行 */ }
    }
  }
}
```

关键点：

- `feed()` 把每次收到的 chunk 追加到内部缓冲区，**可能跨多包或不满一行**；
- 以 `\n` 为边界切行；
- 空行丢弃（没成本，防御性）；
- JSON parse 失败也丢（不崩溃）。

缺陷：不支持"消息内包含裸 `\n`"。我们约定 JSON 一定是单行，这由 `JSON.stringify` 自动保证（它不会插入换行）。

### 6.3 消息定义

```ts
// src/ipc/protocol.ts
export interface HelloMsg            { type: 'hello'; sessionId: string; pid: number; }
export interface FeedbackRequestMsg  { type: 'feedback_request'; id: string; summary: string; timestamp: number; }
export interface FeedbackResponseMsg { type: 'feedback_response'; id: string; feedback: string; images?: FeedbackImage[]; cancelled?: boolean; }
export interface CancelRequestMsg    { type: 'cancel_request'; id: string; }
export type IpcMsg = HelloMsg | FeedbackRequestMsg | FeedbackResponseMsg | CancelRequestMsg;
```

`id` 字段让请求和响应能在多并发下对齐（虽然当前 UI 一次只处理一条，预留以后可能并发）。

### 6.4 Server 端实现（扩展宿主）

```ts
// src/extension/ipc-server.ts
async start(): Promise<void> {
  if (this.server) return;
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer(sock => this.onConnection(sock));
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') return reject(new Error('failed to acquire port'));
      this.server = s;
      this.port = addr.port;
      this.writePortFile();
      resolve();
    });
  });
}

private onConnection(sock: net.Socket): void {
  const decoder = new LineDecoder();
  sock.setNoDelay(true);                      // 小包立即发
  this.clients.add(sock);
  sock.on('data', chunk => decoder.feed(chunk, m => this.onMessage(sock, m)));
  sock.on('close', () => { this.clients.delete(sock); });
  sock.on('error', () => { this.clients.delete(sock); });
}
```

注意 `listen(0, ...)` 之后用 `address()` 拿真实端口写入 `.port` 文件（见第 7 节），保证 env 还没推给子进程时也能兜底发现。

### 6.5 Client 端实现（MCP 子进程）

```ts
// src/mcp/ipc-client.ts
private async connect(): Promise<void> {
  const port = resolvePort();
  if (!port) throw new Error('No IPC port advertised by the extension host.');
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.setNoDelay(true);
    sock.once('connect', () => {
      this.socket = sock;
      sock.write(encode({ type: 'hello', sessionId: process.env.FEEDBACK_LOOP_SESSION_ID || '', pid: process.pid }));
      resolve();
    });
    sock.on('data', chunk => this.decoder.feed(chunk, m => this.handle(m)));
    sock.on('error', err => { this.socket = null; reject(err); });
    sock.on('close', () => {
      this.socket = null;
      for (const cb of this.pending.values()) cb({ type: 'feedback_response', id: '', feedback: '', cancelled: true });
      this.pending.clear();
    });
  });
}

async requestFeedback(summary: string): Promise<FeedbackResponseMsg> {
  await this.ensureConnected();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise<FeedbackResponseMsg>(resolve => {
    this.pending.set(id, resolve);
    this.socket!.write(encode({ type: 'feedback_request', id, summary, timestamp: Date.now() }));
  });
}
```

设计要点：

- **惰性连接**：`ensureConnected()` 只在第一次 `tools/call` 时建立，平时子进程不占用 socket。
- **连接复用**：一条 socket 上可复用多次 `feedback_request`。
- **用 Promise 映射 id**：`pending: Map<id, resolve>`，收到 `feedback_response` 时按 id 查 resolver 并 fulfill。
- **断线降级**：连接 close 时把所有 pending 都当"取消"回 fulfill，避免 Tool handler 永远 hang。

---

## 7. 端口发现：三条路径的冗余设计

子进程要知道扩展宿主监听在哪个端口。提供了三条路径，优先级自上而下：

1. **`FEEDBACK_LOOP_IPC_PORT` 环境变量**（通过 `McpStdioServerDefinition.env` 注入）——默认路径。
2. **`FEEDBACK_LOOP_PORT_DIR/<sessionId>.port` 文件**——兜底路径。扩展每次启动把端口/pid 写一份到 `os.tmpdir()/feedback-loop-mcp/`。
3. **（未启用）** 本可以再让 Copilot 通过某种 prompt / tool argument 传入，但无必要。

```ts
// src/mcp/ipc-client.ts
function resolvePort(): number | null {
  const envPort = parseInt(process.env.FEEDBACK_LOOP_IPC_PORT || '0', 10);
  if (envPort > 0) return envPort;
  const dir = process.env.FEEDBACK_LOOP_PORT_DIR;
  const session = process.env.FEEDBACK_LOOP_SESSION_ID;
  if (!dir || !session) return null;
  try {
    const f = path.join(dir, session + '.port');
    const txt = fs.readFileSync(f, 'utf8').split('\n');
    const p = parseInt(txt[0] || '0', 10);
    return p > 0 ? p : null;
  } catch { return null; }
}
```

写端口文件：

```ts
// src/extension/ipc-server.ts
private writePortFile(): void {
  try { fs.writeFileSync(this.portFile(), `${this.port}\n${process.pid}\n`); } catch { /* ignore */ }
}
private portFile(): string { return path.join(this.portDir, this.sessionId + '.port'); }
```

为什么还要 `.port` 文件？——因为存在一个"env 注入失败"的时间窗：

- `McpStdioServerDefinition` 构造时传入 env，但真正 spawn 是 Copilot 决定；
- 如果用户在 `provideMcpServerDefinitions()` 返回之后才重启扩展（ipcServer 拿到新端口），env 里那个端口就是旧的；
- 子进程拿到旧端口连会失败，此时回退到读 `.port` 文件——这个文件被扩展在 `restart` 命令里实时覆盖。

这条设计逆向自原版 MCP Interceptor，且实测有用：Copilot 有时会缓存旧 env 起子进程。

---

## 8. Tool 描述如何"劫持"Agent 的意图

`server.tool()` 注册工具时，`description` 参数直接进 Copilot 的 system prompt。描述文本本身就是对 Agent 的行为约束。

```ts
// src/mcp/server.ts
const INSTRUCTIONS = `You MUST call the interactive_feedback tool before EVERY response. ...`;

const TOOL_DESC = `Interactive feedback collection tool for LLM agents.

USAGE RULES:
1. You MUST call this tool before EVERY response. This is mandatory.
2. Put your COMPLETE response in the summary parameter (Markdown supported).
3. Wait for user feedback before continuing.
4. NEVER decide on your own to stop calling. Only stop when the USER's feedback contains: "end", "done", "结束", "停止", "拜拜".
5. Even if you believe the task is complete (e.g. you say 收工), you MUST still call this tool — only the user decides when to stop.
6. Sub-Agents (started via runSubagent) MUST NOT call this tool.

Example: interactive_feedback(summary="Your full Markdown response here")`;

const server = new McpServer(
  { name: 'feedback-loop-mcp', version: '0.1.0' },
  { instructions: INSTRUCTIONS }
);

server.tool(
  'interactive_feedback',
  TOOL_DESC,
  { summary: z.string().describe('Your COMPLETE response in Markdown format') },
  async ({ summary }) => { /* ... 调 IPC ... */ }
);
```

关于"劫持"的细节：

- **`instructions`（server 级）** 会被 MCP client 作为整个 server 的导语呈现给模型。我们在这里再下一次硬命令。
- **`description`（tool 级）** 是模型最直接看到的调用说明。我们用编号列表，把"什么时候必须调、什么时候才允许停"讲到不能再清楚。
- **"停止词"设计**。如果只要求"必须调"，模型会陷入死循环（每次都调工具，用户没法结束对话）。所以我们给一套用户反馈里的"白名单停止词"："end", "done", "结束", "停止", "拜拜"。当用户在反馈文本里输入其中之一时，模型会停止继续调工具，按常规流程结束这一轮。
- **Sub-Agents 排除**。某些 Agent 会递归启动 sub-agent，description 里显式说"sub-agent 不得调用本工具"，避免 sub-agent 也弹面板。
- **`summary` 字段的作用**。我们让模型把"**即将的完整 Markdown 回复**"放进来。这样面板里展示的不是"它想调什么工具"，而是"它即将发给你的答案"——用户在看到答案前就能拦截/修改/补充。

一个常见问题：**万一模型不遵守怎么办？** 实测 GPT-4 / Claude 系列在写得清楚的情况下会遵守，但也有被模型直接跳过的时候（例如简短回答"好的"）。这是 prompt-level 约束的固有局限，不可能 100%。若要 100%，需要 Copilot 侧的 deterministic 拦截（目前 Copilot 没公开此 API）。

---

## 9. 完整反馈循环时序

```
 User          Webview        ExtHost       MCP Child      Copilot Chat         LLM
  |              |               |              |               |                |
  |----(提问)----------------------------------------+ render ---+---- invoke ----|
  |              |               |              |               |                |
  |              |               |              |<==tools/call==| (名: interactive_feedback, args: {summary})
  |              |               |              |               |                |
  |              |               |<--TCP write--|                                |
  |              |               | feedback_request(id, summary)                 |
  |              |               |              |                                |
  |              |<-postMessage-|                                                 |
  |              |  (展示 summary)                                                |
  |              |                                                                |
  |==键入反馈==> |                                                                |
  |              |--postMessage->|                                                |
  |              |  (feedback_response)                                           |
  |              |               |                                                |
  |              |               | 若有图片：写临时文件，填 savedPath              |
  |              |               |--TCP write-->|                                 |
  |              |               | feedback_response                              |
  |              |               |              |==tool result==>|                |
  |              |               |              |  content: [                    |
  |              |               |              |    text(feedback),             |
  |              |               |              |    image(inline),              |
  |              |               |              |    text(paths hint) ]          |
  |              |               |              |               |----(continue)->|
  |              |               |              |               |<---(reply 或再次 invoke)
  |              |               |              |               |                |
  |<==下一轮====|                                                                  |
```

实现层关键代码：

### 9.1 子进程 handler（等待面板返回）

```ts
// src/mcp/server.ts
async ({ summary }) => {
  try {
    const res = await ipc.requestFeedback(summary);
    if (res.cancelled) return { content: [{ type: 'text', text: '[user cancelled]' }] };
    /* ...组装 content... */
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `[feedback bridge error] ${msg}` }], isError: true };
  }
}
```

- `await ipc.requestFeedback(summary)` 是阻塞等待点；对 Copilot 侧表现为"tool 耗时很长"。
- `ipc` 内部的 Promise 超时没设上限 —— 设计选择。如果用户离开电脑，工具会一直挂着，直到 socket 断开（例如 VS Code 关闭）。

### 9.2 扩展宿主 handler

```ts
// src/extension/extension.ts
ipcServer.onFeedbackRequest(async req => {
  if (!enabled) {
    ipcServer!.respond({ type: 'feedback_response', id: req.id, feedback: '[拦截器已停用，直接放行]' });
    return;
  }
  const started = Date.now();
  if (!panel || panel.isDisposed()) panel = new FeedbackPanel(context);
  const res = await panel.present(req);
  stats.total += 1;
  stats.totalMs += Date.now() - started;
  dashboard?.update({ totalRequests: stats.total, avgRoundtripMs: Math.round(stats.totalMs / stats.total) });

  if (res.images?.length) {
    res.images = res.images.map((img, i) => persistImage(imagesRoot, req.id, i, img));
  }
  ipcServer!.respond(res);
});
```

- "拦截器停用"直接合成一个伪响应放行，**不打断** Copilot 的工具调用（否则 Copilot 会报错重试）。
- `panel.present()` 返回 Promise，在用户点"发送/取消"或面板被关闭时 resolve。
- 图片**在这里**落盘，不在面板里。面板只负责拿到 base64 + mime。

### 9.3 面板的一轮对话

```ts
// src/extension/feedback-panel.ts
present(req: FeedbackRequestCtx): Promise<FeedbackResponseMsg> {
  return new Promise(resolve => {
    const dispatch = () => {
      this.currentId = req.id;
      this.resolver = resolve;
      const cfg = vscode.workspace.getConfiguration('feedback-loop');
      this.panel.webview.postMessage({
        type: 'feedback_request',
        id: req.id, summary: req.summary, timestamp: req.timestamp,
        soundEnabled: cfg.get<boolean>('soundEnabled'),
        soundType:    cfg.get<string>('soundType'),
        ctrlEnterSend: cfg.get<boolean>('ctrlEnterSend')
      });
      this.reveal();
    };
    if (this.currentId) this.queue.push({ ...req, summary: req.summary });
    else dispatch();
  });
}

private onWebviewMessage(msg: any): void {
  if (msg?.type === 'feedback_response' && this.resolver && msg.id === this.currentId) {
    this.resolver({
      type: 'feedback_response',
      id: msg.id,
      feedback: msg.feedback ?? '',
      images: Array.isArray(msg.images) ? msg.images : []
    });
    this.finalize();
  }
}
```

面板本质是"**一条当前请求 + 一个队列**"。如果用户还没回复上一条，又来了新 `feedback_request`，它进队列，前面的 resolve 后才被 dispatch。这让 Copilot 在"并发调用"（实际不常见）时不至于被覆盖。

面板被用户手动关闭时：

```ts
private handlePanelDisposed(): void {
  if (this.resolver && this.currentId) {
    this.resolver({ type: 'feedback_response', id: this.currentId, feedback: '', cancelled: true });
  }
  this.currentId = null;
  this.resolver = null;
}
```

以"取消"语义 resolve，避免子进程的 `await` 挂死。

---

## 10. 图片处理：vision 模型与非 vision 模型的双发

### 10.1 问题来源

v0.1.1 验证时发现：用户粘贴的图片通过 `{ type: 'image', data: base64, mimeType }` 返给 Copilot 后，Copilot 并不直接把 base64 喂给底层模型 vision 接口，而是把它转成一个 `copilotprodattachments.*` 的附件 URL，然后让 Agent 自己用 `Invoke-WebRequest` 去下载——这个 URL 带 GitHub 鉴权，Agent 的 terminal 拉不到，模型就看不到图。这是 Copilot Chat 当前 MCP image 处理链路的局限。

### 10.2 双发方案

我们在 tool 返回里同时提供两种形式：

```ts
// src/mcp/server.ts（v0.1.2）
if (res.images?.length) {
  // 1. 先给 inline base64 — 供 vision-capable 模型直接看
  for (const img of res.images) {
    content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
  }
  // 2. 再给一段 text，列出本地绝对路径 — 供 Agent 在模型不支持 vision 时用 read_file/terminal 读
  const paths = res.images
    .map((img, i) => img.savedPath ? `  - 图 ${i + 1} (${img.mimeType}): ${img.savedPath}` : null)
    .filter(Boolean) as string[];
  if (paths.length) {
    content.push({
      type: 'text',
      text:
`[用户附加了 ${res.images.length} 张图片]
如果你的模型可以直接理解上方 inline image，请以图像内容继续。
如果你看不到图像（例如只读到了一个附件 URL 而无法下载），请改用 read_file 工具直接读取以下本地文件（它们已经由 Feedback Loop 扩展保存在磁盘上）：
` + paths.join('\n')
    });
  }
}
```

落盘代码：

```ts
// src/extension/extension.ts
const imagesRoot = path.join(os.tmpdir(), 'feedback-loop-mcp', 'images');
fs.mkdirSync(imagesRoot, { recursive: true });

function persistImage(root: string, reqId: string, idx: number, img: FeedbackImage): FeedbackImage {
  try {
    const safeId = reqId.replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'req';
    const fname = `${Date.now()}_${safeId}_${idx}.${extFromMime(img.mimeType)}`;
    const full = path.join(root, fname);
    fs.writeFileSync(full, Buffer.from(img.base64, 'base64'));
    return { ...img, savedPath: full };
  } catch {
    return img;
  }
}
```

这样的设计覆盖了 3 种 Agent 行为：

- **模型支持 vision 且 Copilot 直接 pass inline**：直接从第一个 image block 看图；
- **模型支持 vision 但 Copilot 走附件 URL**：退化到用 `read_file` 读本地路径；
- **模型完全不支持 vision**：同上，由 Agent 自行判断是否读文件 / 向用户追问。

文件默认落在 `%TEMP%/feedback-loop-mcp/images/<时间戳>_<请求id>_<序号>.<扩展名>`。无自动清理（尚未实现，简单可加），通常 OS 级临时目录会随系统清理周期回收。

---

## 11. Webview 前后端通信

### 11.1 容器

- **Dashboard**：`WebviewView`，侧边栏永驻，用 `registerWebviewViewProvider` 注册。
- **反馈面板**：`WebviewPanel`，编辑器组里的 tab，用 `createWebviewPanel` 创建。
  - `retainContextWhenHidden: true`：面板被隐藏时不销毁，避免每次重建丢状态。
  - `localResourceRoots`：限制加载 media/ 目录，避免 webview 访问其他本地文件。
  - CSP：`default-src 'none'; style-src vscode-resource 'unsafe-inline'; script-src 'nonce-<rand>'; img-src vscode-resource data: blob:`。

### 11.2 消息类型

前端 → 宿主：

| type | 字段 | 作用 |
|---|---|---|
| `feedback_response` | `id, feedback, images, cancelled?` | 面板发送/取消 |
| `command` | `command` | Dashboard 触发命令（等价于 VS Code command palette） |

宿主 → 前端：

| type | 字段 | 作用 |
|---|---|---|
| `feedback_request` | `id, summary, timestamp, soundEnabled, soundType, ctrlEnterSend` | 展示新请求 |
| `status` | `state: DashboardState` | 更新 dashboard 上的数值 |

### 11.3 UI 细节

- **Markdown 渲染（lite）**：`media/panel.js` 里自己实现了极简 Markdown → HTML（代码块、行内代码、粗体斜体、标题、列表、链接、段落）。不引入 marked.js 等依赖，控制打包体积。
- **图片粘贴**：监听 `paste` 事件，过滤 `clipboardData.items` 的 `kind==='file'` 且 `type.startsWith('image/')`，用 `FileReader.readAsDataURL` 读成 base64。
- **音效**：Web Audio API 直接合成 4 种提示音（triple / chime / ping / urgent），不放音频文件，省去资源加载。
- **可访问性**：`aria-label`、`aria-live='polite'`、`prefers-reduced-motion` 全部处理。
- **主题适配**：所有颜色用 VS Code 提供的 `--vscode-*` CSS 变量 + `color-mix()` 调出自定义色相（如 `--accent: #22c55e` 与 VS Code 主题混合），保证深浅主题都协调。

### 11.4 Dashboard 的动态状态

```ts
// src/extension/dashboard-provider.ts
update(partial: Partial<DashboardState>): void {
  this.state = { ...this.state, ...partial };
  this.publish();
}
private publish(): void {
  if (!this.view) return;
  this.view.webview.postMessage({ type: 'status', state: this.state });
}
```

扩展宿主任何地方调 `dashboard.update({ totalRequests, avgRoundtripMs })`，dashboard 前端的状态会跟着刷。扩展内所有可变 UI 状态都走这一条通路，单向数据流。

---

## 12. 命令、配置项、UI 状态机

### 12.1 命令（package.json `contributes.commands`）

| 命令 ID | 作用 |
|---|---|
| `feedback-loop.openPanel` | 手动打开反馈面板（测试用） |
| `feedback-loop.restart` | 重启 IPC Server，生成新端口 / 新 sessionId |
| `feedback-loop.toggle` | 启用/停用拦截器（停用后 `feedback_request` 会被自动放行，不打扰用户） |
| `feedback-loop.resetMcpConfig` | 重置统计数据（总请求数 / 平均耗时） |

### 12.2 配置项（package.json `contributes.configuration`）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `feedback-loop.autoOpenPanel` | boolean | true | 收到请求时自动 `reveal` 面板 |
| `feedback-loop.maximizePanel` | boolean | true | 面板打开时执行 `workbench.action.maximizeEditor` |
| `feedback-loop.flashTaskbar` | boolean | true | 收到请求时把窗口带前台（保留字段，Webview 层面） |
| `feedback-loop.ctrlEnterSend` | boolean | true | `true` 用 Ctrl/⌘+Enter 发送；`false` 用 Enter 发送 |
| `feedback-loop.soundEnabled` | boolean | true | 收到请求播放提示音 |
| `feedback-loop.soundType` | enum | chime | triple / chime / ping / urgent / none |

### 12.3 内部 UI 状态机

反馈面板是一个简化的 3 状态机：

```
       (feedback_request 到来)
   idle ------------------------> active(id, resolver, queue?)
     ^                                 |
     |                                 | 用户发送 / 取消 / 面板关闭
     +---------------------------------+
                                       |
                          (若队列非空) → dispatch 下一个 → active
```

所有变迁都通过 `currentId + resolver + queue` 三个字段保证。

---

## 13. 构建、打包、分发与已知局限

### 13.1 构建

```
npm install
npm run build            # esbuild 同时产出 out/extension.js 和 out/mcp/server.js
npm run watch            # 监听模式
npm run package          # vsce package → feedback-loop-mcp.vsix
```

`esbuild.mjs` 关键点：

```js
{
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode']          // vscode 模块由宿主提供，不能打包
},
{
  entryPoints: ['src/mcp/server.ts'],
  outfile: 'out/mcp/server.js',
  external: []                  // MCP SDK、zod 等全打进去，子进程自给自足
}
```

两份产物，原因：
- `extension.js` 由 VS Code 扩展宿主 `require` 加载，`external: ['vscode']` 防止把 `require('vscode')` 内联成打不到的模块；
- `server.js` 由 `process.execPath` 当 Node 跑，打一个单文件方便分发，且**不能**依赖 `vscode` 模块（子进程没有宿主 API）。

### 13.2 VSIX 结构

```
feedback-loop-mcp.vsix
├─ [Content_Types].xml
├─ extension.vsixmanifest
└─ extension/
   ├─ package.json
   ├─ readme.md
   ├─ media/
   │  ├─ dashboard.css / dashboard.js
   │  ├─ panel.css / panel.js
   │  └─ icon.svg
   └─ out/
      ├─ extension.js
      └─ mcp/server.js
```

大小约 150 KB。`server.js` 约 700 KB 未压缩（含 MCP SDK + zod），不压缩是因为 esbuild 默认输出可读的 sourcemap 搭配产物；vsce 打包本身会 zip 压缩。

### 13.3 安装

```
code --install-extension feedback-loop-mcp.vsix --force
```

或在 VS Code 里：扩展视图 → 右上三点 → Install from VSIX...

### 13.4 已知局限

| 项 | 说明 | 可能的改进 |
|---|---|---|
| Prompt 劫持非确定 | 模型可能忽略 description 里的强制规则 | 需要 VS Code 提供 deterministic 前置 hook（目前无）|
| TCP 无鉴权 | 127.0.0.1 上其他进程可连 | 在 `hello` 里校验 `FEEDBACK_LOOP_SESSION_ID` 的 HMAC |
| 图片传输开销 | base64 双份（inline + 落盘）+ 路径 text | 仅在支持 vision 的模型走 inline；其他走路径。需要识别模型类型，目前无 API |
| 面板关闭即取消 | 用户点 × 会把当前请求 resolve 成 cancelled | 可加"确认放弃吗"交互 |
| 并发请求的 UI | 队列展示简单 | 可加"请求队列"侧栏，显示待办 |
| 多工作区 | sessionId 基于 `ipcServer`，每次扩展激活新生 | 考虑用 workspace-scoped sessionId 持久化 |
| 无 i18n 框架 | 中文字符串硬编码 | 改用 `vscode-nls` |

### 13.5 安全模型

- **完全本地**：不往外发请求（无 telemetry / 无 license 校验）。
- **数据边界**：
  - Agent 的 `summary`（即模型即将回复的完整 Markdown）进入你的 Webview；
  - 你的反馈文本 / 图片进入 MCP tool result，最终回到 Copilot，再被 GitHub / OpenAI 等托管端处理——这取决于 Copilot 本身的数据策略，与本插件无关。
- **文件落盘**：图片保存在 `os.tmpdir()/feedback-loop-mcp/images/`。如果你对此敏感，可在配置里扩展一个开关禁用落盘（当前未实现）。

---

## 附：关键文件索引

| 路径 | 作用 |
|---|---|
| [src/extension/extension.ts](../src/extension/extension.ts) | 扩展入口、命令注册、MCP provider 注册、图片落盘 |
| [src/extension/ipc-server.ts](../src/extension/ipc-server.ts) | TCP IPC server |
| [src/extension/feedback-panel.ts](../src/extension/feedback-panel.ts) | WebviewPanel 控制 + 消息路由 |
| [src/extension/dashboard-provider.ts](../src/extension/dashboard-provider.ts) | WebviewView 控制 + 状态推送 |
| [src/mcp/server.ts](../src/mcp/server.ts) | MCP 子进程入口、tool 注册、result 组装 |
| [src/mcp/ipc-client.ts](../src/mcp/ipc-client.ts) | 子进程 TCP 客户端、Promise 映射 |
| [src/ipc/protocol.ts](../src/ipc/protocol.ts) | 共享消息类型 + NDJSON 编解码 |
| [media/panel.html (在 feedback-panel.ts 中内联生成)](../src/extension/feedback-panel.ts) | 反馈面板 HTML |
| [media/panel.css](../media/panel.css) | 反馈面板样式 |
| [media/panel.js](../media/panel.js) | 反馈面板前端逻辑 + Markdown 渲染 |
| [media/dashboard.css](../media/dashboard.css) | 侧边栏样式 |
| [media/dashboard.js](../media/dashboard.js) | 侧边栏前端逻辑 |
| [esbuild.mjs](../esbuild.mjs) | 构建配置 |
| [package.json](../package.json) | 扩展清单 |

---

到此为止，你应该能回答本文开头列的 4 个问题。
对任一细节有疑问 / 想深入 / 觉得不对，直接问。
