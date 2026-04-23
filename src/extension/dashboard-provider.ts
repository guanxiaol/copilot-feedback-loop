import * as vscode from 'vscode';
import * as path from 'node:path';

export interface DashboardState {
  enabled: boolean;
  connected: boolean;
  port: number;
  sessionId: string;
  totalRequests: number;
  avgRoundtripMs: number;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private state: DashboardState = {
    enabled: true,
    connected: false,
    port: 0,
    sessionId: '',
    totalRequests: 0,
    avgRoundtripMs: 0
  };

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.publish();
  }

  update(partial: Partial<DashboardState>): void {
    this.state = { ...this.state, ...partial };
    this.publish();
  }

  private publish(): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'status', state: this.state });
  }

  private onMessage(msg: any): void {
    if (msg?.type === 'command') {
      vscode.commands.executeCommand(msg.command).then(undefined, () => {/* ignore */});
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const mediaRoot = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
    );
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${mediaRoot}/dashboard.css">
</head>
<body>
  <main class="dash">
    <header class="brand">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3.5-7.1"/><polyline points="21 4 21 9 16 9"/>
          <path d="M8 12h8"/><path d="M8 8h5"/><path d="M8 16h6"/>
        </svg>
      </div>
      <div class="brand-text">
        <div class="title">Feedback Loop</div>
        <div class="sub">MCP 拦截器</div>
      </div>
      <span id="status-pill" class="pill">离线</span>
    </header>

    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">运行状态</span>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-label">监听端口</span>
          <span id="port" class="stat-value mono">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">会话 ID</span>
          <span id="session" class="stat-value mono">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">累计请求</span>
          <span id="requests" class="stat-value mono">0</span>
        </div>
        <div class="stat">
          <span class="stat-label">平均耗时</span>
          <span id="rt" class="stat-value mono">0 ms</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">快捷操作</span>
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-cmd="feedback-loop.openPanel">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18"/></svg>
          <span>打开反馈面板</span>
        </button>
        <button class="btn btn-ghost" data-cmd="feedback-loop.toggle">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="8" cy="12" r="3"/></svg>
          <span id="toggle-label">启用 / 停用</span>
        </button>
        <button class="btn btn-ghost" data-cmd="feedback-loop.restart">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><polyline points="21 4 21 9 16 9"/></svg>
          <span>重启 MCP 服务</span>
        </button>
        <button class="btn btn-ghost btn-danger" data-cmd="feedback-loop.resetMcpConfig">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>
          <span>重置统计</span>
        </button>
      </div>
    </section>

    <footer class="foot">
      <span class="mono">v0.1.0</span>
      <span class="dot">·</span>
      <a id="mcp-hint" class="link">MCP 协议</a>
    </footer>
  </main>
  <script nonce="${nonce}" src="${mediaRoot}/dashboard.js"></script>
</body>
</html>`;
  }
}
