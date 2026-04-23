import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { IpcServer } from './ipc-server';
import { FeedbackPanel } from './feedback-panel';
import { DashboardProvider } from './dashboard-provider';
import { FeedbackImage, FeedbackResponseMsg } from '../ipc/protocol';

interface LmApi {
  registerMcpServerDefinitionProvider?: (id: string, provider: any) => vscode.Disposable;
}

interface McpStdioServerDefinitionCtor {
  new (label: string, command: string, args: string[], env: Record<string, string>): unknown;
}

let ipcServer: IpcServer | null = null;
let panel: FeedbackPanel | null = null;
let dashboard: DashboardProvider | null = null;
let enabled = true;
let stats = { total: 0, totalMs: 0 };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  dashboard = new DashboardProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('feedback-loop.dashboard', dashboard)
  );

  ipcServer = new IpcServer();
  await ipcServer.start();
  const imagesRoot = path.join(os.tmpdir(), 'feedback-loop-mcp', 'images');
  try { fs.mkdirSync(imagesRoot, { recursive: true }); } catch { /* ignore */ }

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

    // 图片落盘，附加 savedPath，方便 Agent 走 read_file / terminal 读二进制
    if (res.images?.length) {
      res.images = res.images.map((img, i) => persistImage(imagesRoot, req.id, i, img));
    }

    ipcServer!.respond(res);
  });

  dashboard.update({
    enabled,
    connected: true,
    port: ipcServer.getPort(),
    sessionId: ipcServer.sessionId
  });

  // ---- commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('feedback-loop.openPanel', () => {
      if (!panel || panel.isDisposed()) panel = new FeedbackPanel(context);
      panel.reveal();
    }),
    vscode.commands.registerCommand('feedback-loop.restart', async () => {
      ipcServer?.stop();
      ipcServer = new IpcServer();
      await ipcServer.start();
      dashboard?.update({ port: ipcServer.getPort(), sessionId: ipcServer.sessionId });
      vscode.window.showInformationMessage(`反馈回路已在端口 ${ipcServer.getPort()} 重启`);
    }),
    vscode.commands.registerCommand('feedback-loop.toggle', () => {
      enabled = !enabled;
      dashboard?.update({ enabled });
      vscode.window.showInformationMessage(`反馈回路已${enabled ? '启用' : '停用'}`);
    }),
    vscode.commands.registerCommand('feedback-loop.resetMcpConfig', () => {
      stats = { total: 0, totalMs: 0 };
      dashboard?.update({ totalRequests: 0, avgRoundtripMs: 0 });
      vscode.window.showInformationMessage('反馈回路统计数据已重置');
    })
  );

  // ---- MCP server definition provider ----
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const McpStdioServerDefinition = (vscode as unknown as { McpStdioServerDefinition?: McpStdioServerDefinitionCtor }).McpStdioServerDefinition;
  if (lm?.registerMcpServerDefinitionProvider && McpStdioServerDefinition) {
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
  } else {
    vscode.window.showWarningMessage('反馈回路：当前 VS Code 版本未暴露 MCP Server Provider API (vscode.lm.registerMcpServerDefinitionProvider)，请升级到 1.99 或更新版本。');
  }

  context.subscriptions.push({ dispose: () => ipcServer?.stop() });
}

export function deactivate(): void {
  ipcServer?.stop();
  ipcServer = null;
}

function extFromMime(mime: string): string {
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/gif/i.test(mime)) return 'gif';
  if (/webp/i.test(mime)) return 'webp';
  if (/bmp/i.test(mime)) return 'bmp';
  if (/svg/i.test(mime)) return 'svg';
  return 'bin';
}

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
