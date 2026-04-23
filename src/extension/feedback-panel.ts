import * as vscode from 'vscode';
import * as path from 'node:path';
import { FeedbackResponseMsg } from '../ipc/protocol';
import { FeedbackRequestCtx } from './ipc-server';

/** Standalone WebviewPanel that collects a feedback reply for one request. */
export class FeedbackPanel {
  private panel: vscode.WebviewPanel;
  private currentId: string | null = null;
  private resolver: ((res: FeedbackResponseMsg) => void) | null = null;
  private queue: FeedbackRequestCtx[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'feedback-loop.panel',
      '反馈面板 · Feedback Loop',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))] }
    );
    this.panel.webview.html = this.buildHtml();
    this.panel.webview.onDidReceiveMessage(msg => this.onWebviewMessage(msg));
    this.panel.onDidDispose(() => this.handlePanelDisposed());
  }

  reveal(): void {
    const cfg = vscode.workspace.getConfiguration('feedback-loop');
    if (cfg.get<boolean>('maximizePanel')) {
      vscode.commands.executeCommand('workbench.action.maximizeEditor').then(undefined, () => {/* ignore */});
    }
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  present(req: FeedbackRequestCtx): Promise<FeedbackResponseMsg> {
    return new Promise(resolve => {
      const dispatch = () => {
        this.currentId = req.id;
        this.resolver = resolve;
        const cfg = vscode.workspace.getConfiguration('feedback-loop');
        this.panel.webview.postMessage({
          type: 'feedback_request',
          id: req.id,
          summary: req.summary,
          timestamp: req.timestamp,
          soundEnabled: cfg.get<boolean>('soundEnabled'),
          soundType: cfg.get<string>('soundType'),
          ctrlEnterSend: cfg.get<boolean>('ctrlEnterSend')
        });
        this.reveal();
      };
      if (this.currentId) this.queue.push({ ...req, summary: req.summary });
      else dispatch();
    });
  }

  cancel(id: string): void {
    if (this.currentId === id && this.resolver) {
      this.resolver({ type: 'feedback_response', id, feedback: '', cancelled: true });
      this.finalize();
    }
  }

  private finalize(): void {
    this.currentId = null;
    this.resolver = null;
    const next = this.queue.shift();
    if (next) {
      this.currentId = next.id;
      this.panel.webview.postMessage({
        type: 'feedback_request',
        id: next.id,
        summary: next.summary,
        timestamp: next.timestamp
      });
    }
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

  private handlePanelDisposed(): void {
    if (this.resolver && this.currentId) {
      this.resolver({ type: 'feedback_response', id: this.currentId, feedback: '', cancelled: true });
    }
    this.currentId = null;
    this.resolver = null;
  }

  isDisposed(): boolean { return (this.panel as any)._isDisposed ?? false; }

  private buildHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    const mediaRoot = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
    );
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} data: blob:; font-src ${this.panel.webview.cspSource};">
<link rel="stylesheet" href="${mediaRoot}/panel.css">
</head>
<body>
  <main class="shell">
    <!-- 摘要卡片：AI 即将回复的内容 -->
    <section class="card summary-card" aria-labelledby="summary-title">
      <header class="card-head">
        <div class="bot-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="6" width="18" height="13" rx="3"/><path d="M12 3v3"/><circle cx="9" cy="12.5" r="1"/><circle cx="15" cy="12.5" r="1"/><path d="M9 16h6"/>
          </svg>
        </div>
        <div class="card-head-text">
          <h1 id="summary-title">助手的回复</h1>
          <p class="sub" id="meta">等待中…</p>
        </div>
        <span class="pill pill-idle" id="state-pill">待命</span>
      </header>
      <article id="summary" class="summary" aria-live="polite">
        <div class="placeholder">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16.5v.01"/>
          </svg>
          <p>暂无请求。当 Copilot 发起反馈调用时，这里会展示它即将提交的完整回复内容。</p>
        </div>
      </article>
    </section>

    <!-- 输入卡片：用户反馈 -->
    <section class="card compose-card" aria-labelledby="compose-title">
      <header class="card-head">
        <div class="bot-avatar you" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20a8 8 0 0 1 16 0"/><circle cx="12" cy="8" r="4"/>
          </svg>
        </div>
        <div class="card-head-text">
          <h2 id="compose-title">你的反馈</h2>
          <p class="sub">支持粘贴图片 · <kbd id="hint-key">Ctrl</kbd>+<kbd>Enter</kbd> 发送</p>
        </div>
      </header>
      <div class="compose-body">
        <textarea id="feedback" placeholder="继续、修改、或说 “结束”/“done” 让 Copilot 停止…"></textarea>
        <div class="images" id="images" aria-label="已粘贴图片"></div>
      </div>
      <footer class="compose-foot">
        <div class="counters">
          <span id="char-count" class="count">0 字</span>
          <span id="img-count" class="count hidden">0 图</span>
        </div>
        <div class="actions">
          <button id="cancel" class="btn btn-ghost" type="button">取消</button>
          <button id="send" class="btn btn-primary" type="button" disabled>
            <span>发送</span>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 5l7 7-7 7"/></svg>
          </button>
        </div>
      </footer>
    </section>
  </main>
  <script nonce="${nonce}" src="${mediaRoot}/panel.js"></script>
</body>
</html>`;
  }
}
