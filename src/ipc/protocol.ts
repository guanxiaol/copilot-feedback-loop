// 行分隔 JSON 协议：每条消息以 \n 结束
// extension（server 端） <-> mcp-server（client 端）

export interface BaseMsg {
  type: string;
  id?: string;
}

export interface HelloMsg extends BaseMsg {
  type: 'hello';
  sessionId: string;
  pid: number;
}

export interface FeedbackRequestMsg extends BaseMsg {
  type: 'feedback_request';
  id: string;
  summary: string;
  timestamp: number;
}

export interface FeedbackImage {
  mimeType: string;
  base64: string;
  savedPath?: string; // 落盘后的绝对路径（可选）
  name?: string;
}

export interface FeedbackResponseMsg extends BaseMsg {
  type: 'feedback_response';
  id: string;
  feedback: string;
  images?: FeedbackImage[];
  cancelled?: boolean;
}

export interface CancelRequestMsg extends BaseMsg {
  type: 'cancel_request';
  id: string;
}

export type IpcMsg =
  | HelloMsg
  | FeedbackRequestMsg
  | FeedbackResponseMsg
  | CancelRequestMsg;

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
      try {
        onMessage(JSON.parse(line) as IpcMsg);
      } catch {
        // malformed line — drop
      }
    }
  }
}
