import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { encode, LineDecoder, IpcMsg, FeedbackResponseMsg } from '../ipc/protocol';

export interface FeedbackRequestCtx {
  id: string;
  summary: string;
  timestamp: number;
}

export type FeedbackRequestHandler = (req: FeedbackRequestCtx) => void;

/** TCP 127.0.0.1 IPC server + sessionId/.port file broker. */
export class IpcServer {
  private server: net.Server | null = null;
  private port = 0;
  private clients = new Set<net.Socket>();
  private handler: FeedbackRequestHandler | null = null;
  private disposed = false;

  readonly sessionId = crypto.randomBytes(8).toString('hex');
  readonly portDir = path.join(os.tmpdir(), 'feedback-loop-mcp');

  constructor() {
    try { fs.mkdirSync(this.portDir, { recursive: true }); } catch { /* ignore */ }
  }

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
    sock.setNoDelay(true);
    this.clients.add(sock);
    sock.on('data', chunk => decoder.feed(chunk, m => this.onMessage(sock, m)));
    sock.on('close', () => { this.clients.delete(sock); });
    sock.on('error', () => { this.clients.delete(sock); });
  }

  private onMessage(_sock: net.Socket, msg: IpcMsg): void {
    if (msg.type === 'feedback_request') {
      this.handler?.({ id: msg.id, summary: msg.summary, timestamp: msg.timestamp });
    }
    // hello / cancel_request 暂不需要处理
  }

  onFeedbackRequest(h: FeedbackRequestHandler): void { this.handler = h; }

  respond(res: FeedbackResponseMsg): void {
    const wire = encode(res);
    for (const c of this.clients) {
      try { c.write(wire); } catch { /* ignore */ }
    }
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clients) { try { c.destroy(); } catch { /* ignore */ } }
    this.clients.clear();
    try { this.server?.close(); } catch { /* ignore */ }
    this.server = null;
    try { fs.unlinkSync(this.portFile()); } catch { /* ignore */ }
  }

  getPort(): number { return this.port; }

  private portFile(): string { return path.join(this.portDir, this.sessionId + '.port'); }

  private writePortFile(): void {
    try { fs.writeFileSync(this.portFile(), `${this.port}\n${process.pid}\n`); } catch { /* ignore */ }
  }
}
