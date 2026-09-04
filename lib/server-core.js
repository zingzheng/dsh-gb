// dsh-gb — 局域网掌机服务器核心（纯 Node，无 cordis 依赖）。
// 提供：手机页面、SSE 状态推送（手机 + GUI 桥）、动作 API、令牌鉴权、CORS。
// 会话注入 / 状态增强由外层（lib/index.js 的 cordis 宿主）通过钩子挂接。
import { createServer } from 'node:http';
import crypto from 'node:crypto';

const DEFAULT_PORTS = [7788, 7789, 7790, 7791, 7792, 7793, 7794, 7795];
const MAX_BODY = 64 * 1024;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function json(res, code, value, cors) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(cors ? {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-token',
    } : {}),
  });
  res.end(body);
}

function tokenOf(req, query) {
  const header = req.headers['x-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  return query.get('t') ?? '';
}

function validToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : null;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(ab, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class PhoneRemoteServer {
  /**
   * @param {object} hooks
   * @param {(sessionId: string | undefined, text: string) => Promise<{ok: boolean; error?: string}>} hooks.onSend
   *   会话消息注入（v1：不做斜杠命令解析，只注入用户消息）。
   * @param {(sessionId: string | undefined) => ({status: 'running'|'idle'|'none'; summary?: string})} hooks.getSessionMeta
   * @param {(sessionId: string | undefined) => Promise<{ok: boolean; error?: string}>} hooks.onPause
   *   中断当前运行中的 agent（等价于 GUI 的停止）。
   */
  constructor(hooks, options = {}) {
    this.hooks = hooks;
    // 令牌可由宿主注入（持久化复用）；未提供/非法时生成单次随机令牌。
    this.token = validToken(options.token) ?? crypto.randomBytes(16).toString('hex');
    this.port = 0;
    this.state = null;
    this.pending = [];
    this.phones = new Set();
    this.bridges = new Set();
    this.server = null;
    this.ready = false;
    this.lastError = null;
    this.disposers = new Set();
  }

  async start(preferredPorts = DEFAULT_PORTS) {
    for (const port of preferredPorts) {
      try {
        await this.listen(port);
        this.port = port;
        return { ok: true, port };
      } catch {
        // 端口被占用，尝试下一个
      }
    }
    throw new Error('没有可用端口（尝试了 ' + preferredPorts.join(', ') + '）');
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          this.log('error', error instanceof Error ? error.message : String(error));
          if (!res.headersSent) json(res, 500, { ok: false, error: 'internal' }, false);
          else res.destroy();
        });
      });
      const onError = (error) => {
        server.close();
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', onError);
        server.on('error', (error) => this.log('error', `server error: ${String(error)}`));
        this.server = server;
        const heartbeat = setInterval(() => {
          // SSE 心跳，避免代理/系统超时断开
          for (const [res, type] of this.phones) res.write(': hb\n\n');
          for (const [res, type] of this.bridges) res.write(': hb\n\n');
        }, 25000);
        this.disposers.add(() => clearInterval(heartbeat));
        resolve();
      });
    });
  }

  log(level, message) {
    try { this.hooks.log?.(level, message); } catch { /* 忽略日志错误 */ }
  }

  close() {
    for (const dispose of this.disposers) { try { dispose(); } catch { /* noop */ } }
    this.disposers.clear();
    for (const [res] of this.phones) { try { res.end(); } catch { /* noop */ } }
    for (const [res] of this.bridges) { try { res.end(); } catch { /* noop */ } }
    this.phones.clear();
    this.bridges.clear();
    if (this.server) {
      try { this.server.close(); } catch { /* noop */ }
      this.server = null;
    }
  }

  urlFor(ip) {
    return `http://${ip}:${this.port}/?t=${this.token}`;
  }

  /** 重置令牌：立即断开全部手机与桥连接（它们会以新令牌重连/提示重新扫码）。 */
  setToken(token) {
    const next = validToken(token);
    if (next === null) return false;
    this.token = next;
    for (const [res] of this.phones) { try { res.end(); } catch { /* noop */ } }
    for (const [res] of this.bridges) { try { res.end(); } catch { /* noop */ } }
    this.phones.clear();
    this.bridges.clear();
    return true;
  }

  /** GUI 根桥推送基础状态（选中会话、有序列表）。 */
  setBridgeState(state) {
    this.state = state;
    this.lastStateAt = Date.now();
    this.bridgeStateCount = (this.bridgeStateCount ?? 0) + 1;
    this.broadcast();
    try { this.hooks.onBridgeState?.(state); } catch { /* 钩子失败忽略 */ }
  }

  /** GUI 会话中继推送待交互摘要（审批/选择题 carrier 的轻量视图）。 */
  setBridgePending(pending) {
    this.pending = Array.isArray(pending) ? pending : [];
    this.lastPendingAt = Date.now();
    this.broadcast();
  }

  /** 完整合并后的手机端状态。 */
  mergedState() {
    const base = this.state;
    if (base === null) return { connected: false };
    const meta = this.hooks.getSessionMeta(base.sessionId);
    // 标题统一走 Host 缓存（实时日志折叠值），缺失时回退 client 列表值
    const ids = [base.sessionId, ...(Array.isArray(base.sessions) ? base.sessions.map((s) => s.id) : [])];
    let titles = {};
    try {
      titles = this.hooks.getTitles?.(ids) ?? {};
    } catch { /* 钩子失败忽略 */ }
    const titleOf = (id, fallback) => {
      const t = titles[id];
      return typeof t === 'string' && t !== '' ? t : fallback;
    };
    let messages = [];
    try {
      messages = (this.hooks.getMessages?.(base.sessionId) ?? []).slice(0, 40);
    } catch { /* 钩子失败忽略 */ }
    return {
      connected: true,
      sessionId: base.sessionId,
      sessionTitle: base.sessionBlank === true ? '' : titleOf(base.sessionId, base.sessionTitle),
      sessionBlank: base.sessionBlank === true,
      workspaceId: base.workspaceId,
      workspaceTitle: base.workspaceTitle,
      sessions: (Array.isArray(base.sessions) ? base.sessions : []).map((s) => ({ id: s.id, title: titleOf(s.id, s.title) })),
      workspaces: base.workspaces,
      pending: this.pending ?? [],
      status: meta.status,
      summary: meta.summary ?? '',
      messages,
      bridgeOnline: this.bridges.size > 0,
    };
  }

  broadcast() {
    const payload = `data: ${JSON.stringify(this.mergedState())}\n\n`;
    for (const [res] of this.phones) {
      try { res.write(payload); } catch { /* noop */ }
    }
  }

  /** 向 GUI 桥发送命令（open-session / open-workspace / approval-answer / question-answer / ping）。 */
  bridgeCommand(cmd) {
    if (this.bridges.size === 0) return false;
    const payload = `event: cmd\ndata: ${JSON.stringify(cmd)}\n\n`;
    let sent = false;
    for (const [res] of this.bridges) {
      try { res.write(payload); sent = true; } catch { /* noop */ }
    }
    return sent;
  }

  findPending(kind) {
    const pending = this.pending ?? [];
    return pending.find((item) => item.kind === kind);
  }

  async handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const cors = path === '/info' || path.startsWith('/bridge') || path === '/api';
    if (req.method === 'OPTIONS' && cors) {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-token',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (path === '/info') {
      // 仅限本机回环访问：该端点会暴露令牌与完整 URL
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { ok: false, error: 'loopback-only' }, true);
        return;
      }
      json(res, 200, {
        ok: true,
        port: this.port,
        host: this.host ? this.host : null,
        url: `http://${this.host ?? '127.0.0.1'}:${this.port}/?t=${this.token}`,
        phonesOnline: this.phones.size,
        bridgeOnline: this.bridges.size > 0,
        stateReceived: this.state !== null,
        messagesCount: this.state !== null ? (this.hooks.getMessages?.(this.state.sessionId) ?? []).length : 0,
        lastStateAt: this.lastStateAt ?? 0,
        bridgeStateCount: this.bridgeStateCount ?? 0,
        lastActionError: this.lastActionError ?? null,
      }, true);
      return;
    }
    if (path === '/') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden: 令牌无效，请重新扫描二维码');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(this.page);
      return;
    }
    if (path === '/events') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        json(res, 403, { ok: false, error: 'forbidden' }, true);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify(this.mergedState())}\n\n`);
      const record = [res, 'phone'];
      this.phones.add(record);
      const remove = () => this.phones.delete(record);
      res.on('close', remove);
      req.on('close', remove);
      return;
    }
    if (path === '/bridge/events') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        json(res, 403, { ok: false, error: 'forbidden' }, true);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      // 立即让桥重新推送一遍当前状态（含连接握手）
      res.write(`event: cmd\ndata: {"cmd":"refresh"}\n\n`);
      const record = [res, 'bridge'];
      this.bridges.add(record);
      const remove = () => this.bridges.delete(record);
      res.on('close', remove);
      req.on('close', remove);
      return;
    }
    if (path === '/bridge/state') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        json(res, 403, { ok: false, error: 'forbidden' }, true);
        return;
      }
      const body = await readBody(req);
      let state;
      try { state = JSON.parse(body); } catch {
        json(res, 400, { ok: false, error: 'bad-json' }, true);
        return;
      }
      if (state === null || typeof state !== 'object') {
        json(res, 400, { ok: false, error: 'bad-state' }, true);
        return;
      }
      this.setBridgeState(state);
      json(res, 200, { ok: true }, true);
      return;
    }
    if (path === '/bridge/pending') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        json(res, 403, { ok: false, error: 'forbidden' }, true);
        return;
      }
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch {
        json(res, 400, { ok: false, error: 'bad-json' }, true);
        return;
      }
      const pending = payload === null || typeof payload !== 'object' ? null : payload.pending;
      if (!Array.isArray(pending)) {
        json(res, 400, { ok: false, error: 'bad-pending' }, true);
        return;
      }
      this.setBridgePending(pending);
      json(res, 200, { ok: true }, true);
      return;
    }
    if (path === '/api') {
      const token = tokenOf(req, url.searchParams);
      if (!safeEqual(token, this.token)) {
        json(res, 403, { ok: false, error: 'forbidden' }, false);
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method' }, false);
        return;
      }
      const body = await readBody(req);
      let action;
      try { action = JSON.parse(body); } catch {
        json(res, 400, { ok: false, error: 'bad-json' }, false);
        return;
      }
      const outcome = await this.handleAction(action);
      if (!outcome.ok) this.lastActionError = { at: Date.now(), action: action?.action ?? '?', error: outcome.error };
      json(res, outcome.ok ? 200 : 400, outcome, false);
      return;
    }
    json(res, 404, { ok: false, error: 'not-found' }, cors);
  }

  async handleAction(action) {
    if (action === null || typeof action !== 'object') return { ok: false, error: 'bad-action' };
    switch (action.action) {
      case 'send': {
        const text = typeof action.text === 'string' ? action.text.trim() : '';
        if (text === '') return { ok: false, error: 'empty-text' };
        return this.hooks.onSend(this.state?.sessionId, text);
      }
      case 'approval': {
        const outcome = action.outcome === 'allowed-once' || action.outcome === 'rejected' ? action.outcome : null;
        if (outcome === null) return { ok: false, error: 'bad-outcome' };
        const pending = this.findPending('approval');
        if (pending === undefined) return { ok: false, error: 'no-pending-approval' };
        if (!this.bridgeCommand({ cmd: 'approval-answer', key: pending.key, outcome })) {
          return { ok: false, error: 'no-bridge' };
        }
        return { ok: true, ack: 'approval', outcome };
      }
      case 'question-answer': {
        // 整组题目一起提交：answers = [{ id, selected: string[], custom?: string }]
        const answers = Array.isArray(action.answers) ? action.answers : [];
        const sane = answers.filter((a) => a !== null && typeof a === 'object' && typeof a.id === 'string'
          && (Array.isArray(a.selected) ? a.selected.every((s) => typeof s === 'string') : true)
          && (a.custom === undefined || typeof a.custom === 'string'));
        if (sane.length === 0) return { ok: false, error: 'empty-answer' };
        if (sane.length > 12) return { ok: false, error: 'too-many-answers' };
        const pending = this.findPending('question');
        if (pending === undefined) return { ok: false, error: 'no-pending-question' };
        if (pending.supported === false) return { ok: false, error: 'unsupported-question' };
        if (!this.bridgeCommand({ cmd: 'question-answer', key: pending.key, answers: sane })) {
          return { ok: false, error: 'no-bridge' };
        }
        return { ok: true, ack: 'question' };
      }
      case 'switch-session': {
        const sessionId = typeof action.sessionId === 'string' ? action.sessionId : '';
        if (sessionId === '') return { ok: false, error: 'bad-session-id' };
        if (!this.bridgeCommand({ cmd: 'open-session', sessionId })) {
          return { ok: false, error: 'no-bridge' };
        }
        return { ok: true, ack: 'session', sessionId };
      }
      case 'switch-workspace': {
        const workspaceId = typeof action.workspaceId === 'string' ? action.workspaceId : '';
        if (workspaceId === '') return { ok: false, error: 'bad-workspace-id' };
        if (!this.bridgeCommand({ cmd: 'open-workspace', workspaceId })) {
          return { ok: false, error: 'no-bridge' };
        }
        return { ok: true, ack: 'workspace', workspaceId };
      }
      case 'pause': {
        return this.hooks.onPause(this.state?.sessionId);
      }
      case 'new-session': {
        const workspaceId = typeof action.workspaceId === 'string' && action.workspaceId !== ''
          ? action.workspaceId
          : this.state?.workspaceId ?? null;
        if (!this.bridgeCommand({ cmd: 'new-session', workspaceId })) {
          return { ok: false, error: 'no-bridge' };
        }
        return { ok: true, ack: 'new-session' };
      }
      case 'nav': {
        const dir = action.dir;
        const state = this.state;
        if (state === null) return { ok: false, error: 'no-bridge' };
        if (dir === 'up' || dir === 'down') {
          if (state.sessions.length === 0) return { ok: false, error: 'no-sessions' };
          const idx = state.sessions.findIndex((s) => s.id === state.sessionId);
          const base = idx === -1 ? (dir === 'up' ? 0 : -1) : idx;
          const step = dir === 'up' ? 1 : -1;
          const next = ((base + step) % state.sessions.length + state.sessions.length) % state.sessions.length;
          if (state.sessions[next].id === state.sessionId) return { ok: false, error: 'single-session' };
          if (!this.bridgeCommand({ cmd: 'open-session', sessionId: state.sessions[next].id })) {
            return { ok: false, error: 'no-bridge' };
          }
          return { ok: true, ack: 'session', sessionId: state.sessions[next].id };
        }
        if (dir === 'left' || dir === 'right') {
          if (state.workspaces.length === 0) return { ok: false, error: 'no-workspaces' };
          const idx = state.workspaces.findIndex((w) => w.id === state.workspaceId);
          const base = idx === -1 ? (dir === 'left' ? 0 : -1) : idx;
          const step = dir === 'left' ? 1 : -1;
          const next = ((base + step) % state.workspaces.length + state.workspaces.length) % state.workspaces.length;
          if (state.workspaces[next].id === state.workspaceId) return { ok: false, error: 'single-workspace' };
          if (!this.bridgeCommand({ cmd: 'open-workspace', workspaceId: state.workspaces[next].id })) {
            return { ok: false, error: 'no-bridge' };
          }
          return { ok: true, ack: 'workspace', workspaceId: state.workspaces[next].id };
        }
        return { ok: false, error: 'bad-dir' };
      }
      default:
        return { ok: false, error: 'unknown-action' };
    }
  }

  setPage(html) {
    this.page = html;
  }

  setHost(host) {
    this.host = host;
  }
}
