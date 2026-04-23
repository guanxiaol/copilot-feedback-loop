import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encode, LineDecoder, IpcMsg, FeedbackResponseMsg } from '../ipc/protocol.js';

/** Resolve TCP port: first env, then $PORT_DIR/$SESSION_ID.port file (PORT\nPID\n). */
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
  } catch {
    return null;
  }
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private decoder = new LineDecoder();
  private pending = new Map<string, (res: FeedbackResponseMsg) => void>();
  private connectPromise: Promise<void> | null = null;

  private async connect(): Promise<void> {
    const port = resolvePort();
    if (!port) throw new Error('No IPC port advertised by the extension host.');
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.setNoDelay(true);
      sock.once('connect', () => {
        this.socket = sock;
        sock.write(encode({
          type: 'hello',
          sessionId: process.env.FEEDBACK_LOOP_SESSION_ID || '',
          pid: process.pid
        }));
        resolve();
      });
      sock.on('data', chunk => this.decoder.feed(chunk, m => this.handle(m)));
      sock.on('error', err => { this.socket = null; reject(err); });
      sock.on('close', () => {
        this.socket = null;
        for (const cb of this.pending.values()) {
          cb({ type: 'feedback_response', id: '', feedback: '', cancelled: true });
        }
        this.pending.clear();
      });
    });
  }

  private handle(msg: IpcMsg): void {
    if (msg.type === 'feedback_response') {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      }
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.socket) return;
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => { this.connectPromise = null; });
    }
    return this.connectPromise;
  }

  async requestFeedback(summary: string): Promise<FeedbackResponseMsg> {
    await this.ensureConnected();
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise<FeedbackResponseMsg>(resolve => {
      this.pending.set(id, resolve);
      this.socket!.write(encode({
        type: 'feedback_request',
        id,
        summary,
        timestamp: Date.now()
      }));
    });
  }
}
