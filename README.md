# Feedback Loop MCP

Local, MIT-licensed VS Code extension that forces Copilot Chat / Agent to confirm with the
human via an `interactive_feedback` MCP tool before every reply.

## Architecture

```
Copilot Agent  <--stdio JSON-RPC-->  out/mcp/server.js (child process, MCP server)
                                              |
                                              | TCP 127.0.0.1:<ephemeral>
                                              v
                                     out/extension.js (extension host, IPC server)
                                              |
                                              v
                                     WebviewPanel (feedback UI)
```

- Extension opens a `net.createServer(...).listen(0, '127.0.0.1')` random TCP port.
- Port + session id are passed to the MCP child via `FEEDBACK_LOOP_IPC_PORT` / `FEEDBACK_LOOP_SESSION_ID`.
- MCP server exposes a single tool: `interactive_feedback(summary: string)`.
- When Copilot calls the tool, the server relays the summary over TCP to the extension;
  extension opens the feedback panel; user replies; the reply is sent back as the tool result.

## Build & install

```
npm install
npm run build
npm run package   # produces feedback-loop-mcp.vsix
```

Install the VSIX with `code --install-extension feedback-loop-mcp.vsix` (or via the
Extensions view "Install from VSIX..." command).
