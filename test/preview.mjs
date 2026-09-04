// 新页面预览服务器：用磁盘上的 phone-page.js + 可注入的静态状态，验证 UI 布局与交互。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreSrc = readFileSync(join(root, 'lib', 'server-core.js'), 'utf8');
const pageSrc = readFileSync(join(root, 'lib', 'phone-page.js'), 'utf8');
const { PhoneRemoteServer } = await import('data:text/javascript;base64,' + Buffer.from(coreSrc).toString('base64'));
const { phonePageHtml } = await import('data:text/javascript;base64,' + Buffer.from(pageSrc).toString('base64'));

const server = new PhoneRemoteServer({
  log: (level, msg) => console.log(`[${level}]`, msg),
  onSend: async () => ({ ok: true }),
  onPause: async () => ({ ok: true }),
  getSessionMeta: () => ({ status: 'idle', summary: '预览模式：这是一个一句话总结示例。' }),
  getMessages: () => [
    { role: 'user', text: '帮我写一个 Game Boy 风格的掌机页面，要能切换消息、滚动阅读。' },
    { role: 'assistant', text: '好的！已经完成 Game Boy 风格的布局：上屏全宽 LCD 显示当前会话状态与消息，摇杆支持 ←→ 切换上一条/下一条消息、↑↓ 滚动长文本，A 发送、B 暂停、YES/NO 处理审批。' },
    { role: 'user', text: '测试一条很长的消息用于验证滚动效果：' + '这是一个较长的内容片段，'.repeat(30) },
  ],
});
server.setPage(phonePageHtml);
server.setHost('192.168.1.99');
await server.start([7797]);
server.setBridgeState({
  sessionId: 's1',
  sessionTitle: '示例会话',
  workspaceId: 'w1',
  workspaceTitle: '示例工作区',
  sessions: [{ id: 's1', title: '示例会话' }, { id: 's2', title: '另一个会话' }],
  workspaces: [{ id: 'w1', title: '示例工作区' }, { id: 'w2', title: '第二个工作区' }],
  pending: [],
});
console.log(`preview ready: http://127.0.0.1:7797/?t=${server.token}`);
