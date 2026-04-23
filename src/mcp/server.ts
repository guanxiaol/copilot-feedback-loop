import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { IpcClient } from './ipc-client.js';

const INSTRUCTIONS = `You MUST call the interactive_feedback tool before EVERY response. Put your complete response in the summary parameter. Wait for user feedback through the tool before continuing. NEVER decide on your own to stop calling this tool. Only stop when the USER's feedback (tool return value) contains a stop phrase: "end", "done", "结束", "停止", "拜拜". Even after saying 收工 or completing a task, you MUST still call this tool for user confirmation. Sub-Agents MUST NOT call this tool.`;

const TOOL_DESC = `Interactive feedback collection tool for LLM agents.

USAGE RULES:
1. You MUST call this tool before EVERY response. This is mandatory.
2. Put your COMPLETE response in the summary parameter (Markdown supported).
3. Wait for user feedback before continuing.
4. NEVER decide on your own to stop calling. Only stop when the USER's feedback contains: "end", "done", "结束", "停止", "拜拜".
5. Even if you believe the task is complete (e.g. you say 收工), you MUST still call this tool — only the user decides when to stop.
6. Sub-Agents (started via runSubagent) MUST NOT call this tool.

Example: interactive_feedback(summary="Your full Markdown response here")`;

async function main() {
  const ipc = new IpcClient();

  const server = new McpServer(
    { name: 'feedback-loop-mcp', version: '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  server.tool(
    'interactive_feedback',
    TOOL_DESC,
    { summary: z.string().describe('Your COMPLETE response in Markdown format') },
    async ({ summary }) => {
      try {
        const res = await ipc.requestFeedback(summary);
        if (res.cancelled) {
          return { content: [{ type: 'text', text: '[user cancelled]' }] };
        }
        type Block =
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string };
        const content: Block[] = [];
        if (res.feedback) content.push({ type: 'text', text: res.feedback });

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
`[用户附加了 ${res.images.length} 张图片]\n` +
`如果你的模型可以直接理解上方 inline image，请以图像内容继续。\n` +
`如果你看不到图像（例如只读到了一个附件 URL 而无法下载），请改用 read_file 工具直接读取以下本地文件（它们已经由 Feedback Loop 扩展保存在磁盘上）：\n` +
paths.join('\n')
            });
          }
        }

        if (content.length === 0) content.push({ type: 'text', text: '' });
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `[feedback bridge error] ${msg}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[feedback-loop-mcp server] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
