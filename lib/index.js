// dsh-gb — HOST 半部：cordis 插件入口。
// 负责：0.0.0.0 局域网 HTTP 服务器（页面 / SSE / API）、令牌、LAN IP 探测、
// 会话事件监听（运行状态 + 一句话总结）、GUI 浏览器同源 /info 路由。
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PhoneRemoteServer } from './server-core.js';
import { phonePageHtml } from './phone-page.js';

export const name = 'dsh-gb';

const PREFERRED_PORTS = [7788, 7789, 7790, 7791, 7792, 7793, 7794, 7795];

// 令牌持久化：机器级（$DSH_HOME 或 ~/.dsh），跨 profile 稳定、抗 profile 重建。
// 首次启动生成一次，之后跨重启复用；设置页可重置（重置即作废旧令牌）。
const TOKEN_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'dsh-gb.token');

function lanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      candidates.push(net.address);
    }
  }
  const isPrivate = (ip) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // docker 网桥默认段（docker0 172.17.x、compose 172.18-172.22.x）不用于扫码，优先物理/真机网段
  const isDocker = (ip) =>
    ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.')
    || ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.');
  const private_ = candidates.filter(isPrivate);
  const nonDocker = private_.filter((ip) => !isDocker(ip));
  return nonDocker[0] ?? private_[0] ?? candidates[0] ?? null;
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 读取或首次生成持久化令牌（32 位 hex）；持久化失败时回退为单次随机。 */
function loadOrCreateToken(log) {
  let existing = null;
  try {
    existing = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch { /* 不存在或不可读 → 生成新令牌 */ }
  if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing;
  const fresh = crypto.randomBytes(16).toString('hex');
  try {
    mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, fresh, 'utf8');
    log('info', `令牌已持久化: ${TOKEN_FILE}`);
  } catch (error) {
    log('error', `令牌持久化失败(回退单次随机): ${error instanceof Error ? error.message : String(error)}`);
  }
  return fresh;
}

export function apply(ctx) {
  const logger = ctx.get('logger');
  const log = (level, message) => {
    try {
      if (logger) logger[level === 'error' ? 'error' : 'info']?.(`[dsh-gb] ${message}`);
    } catch {
      // 日志失败不影响功能
    }
  };

  const runningBySession = new Map();
  const summaryBySession = new Map();

  const server = new PhoneRemoteServer({
    log,
    onSend: async (sessionId, text) => {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'no-session' };
      const agents = ctx.get('agents');
      const agent = agents?.get(sessionId);
      if (agent === undefined) return { ok: false, error: 'session-not-live' };
      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-gb' },
      };
      try {
        agent.followup(message);
        return { ok: true, ack: 'sent' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    onPause: async (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'no-session' };
      const agents = ctx.get('agents');
      const agent = agents?.get(sessionId);
      if (agent === undefined) return { ok: false, error: 'session-not-live' };
      try {
        agent.cancel({ kind: 'user' });
        return { ok: true, ack: 'paused' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    getSessionMeta: (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return { status: 'none', summary: '' };
      return {
        status: runningBySession.get(sessionId) === true ? 'running' : 'idle',
        summary: summaryBySession.get(sessionId) ?? '',
      };
    },
    // 标题统一从 Host 缓存给出（实时日志折叠值）
    getTitles: (ids) => {
      const out = {};
      for (const id of ids ?? []) {
        const t = titleBySession.get(id);
        if (typeof t === 'string' && t !== '') out[id] = t;
      }
      return out;
    },
    getMessages: (sessionId) => messagesBySession.get(sessionId) ?? [],
    onBridgeState: (state) => {
      if (typeof state?.sessionId === 'string' && state.sessionId !== '') scheduleTitleRefresh(state.sessionId);
    },
  }, { token: loadOrCreateToken(log) });
  server.setPage(phonePageHtml);
  server.setHost(lanIp());

  // 实时标题：client 列表的 summary.title 只在连接刷新（list RPC）时更新，
  // 运行期新生成的标题在手机侧拿不到，这里由 Host 从日志折叠读取并缓存。
  const titleBySession = new Map();
  const titleTimers = new Map();
  // 会话消息（供手机端 ←→ 切换、↑↓ 滚动浏览）：只保留文本块，限制数量与长度。
  const messagesBySession = new Map();
  const messageOf = (role, content) => {
    if (!Array.isArray(content)) return null;
    let text = '';
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text === '') return null;
    return { role, text: text.length > 1200 ? text.slice(0, 1200) + '…' : text };
  };
  const refreshMessages = (sessionId) => {
    const query = ctx.get('sessionQuery');
    if (query === undefined) return;
    // listEvents 只含元数据（type/seq/surface），内容要用 readSurface 的折叠表面事件
    query.readSurface(sessionId).then((surface) => {
      const out = [];
      for (const e of surface?.events ?? []) {
        if (e === null || typeof e !== 'object') continue;
        const data = e.data ?? {};
        if (e.type === 'user/message') {
          const m = messageOf('user', data.content);
          if (m !== null) out.push(m);
        } else if (e.type === 'assistant/message') {
          const m = messageOf('assistant', data.message?.content);
          if (m !== null) out.push(m);
        }
      }
      const trimmed = out.slice(-40);
      const prev = messagesBySession.get(sessionId) ?? [];
      const changed = trimmed.length !== prev.length
        || trimmed.some((m, i) => prev[i] === undefined || prev[i].role !== m.role || prev[i].text !== m.text);
      if (changed) {
        messagesBySession.set(sessionId, trimmed);
        server.broadcast();
      }
    }).catch((error) => {
      log('error', `会话消息读取失败(${sessionId}): ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const refreshTitles = (ids) => {
    const query = ctx.get('sessionQuery');
    if (query === undefined) return;
    const unique = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id !== ''))];
    if (unique.length === 0) return;
    query.readTitleSnapshots(unique).then((results) => {
      let changed = false;
      for (const r of results ?? []) {
        const id = r?.sessionId;
        if (id === undefined) continue;
        const next = r?.status === 'fulfilled' && typeof r.value?.title?.title === 'string'
          ? r.value.title.title : '';
        if ((titleBySession.get(id) ?? '') !== next) {
          titleBySession.set(id, next);
          changed = true;
        }
      }
      if (changed) server.broadcast();
    }).catch(() => { /* 标题读取失败忽略 */ });
  };
  const scheduleTitleRefresh = (sessionId) => {
    const prev = titleTimers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    titleTimers.set(sessionId, setTimeout(() => {
      titleTimers.delete(sessionId);
      const ids = [sessionId];
      const base = server.state;
      if (base !== null && Array.isArray(base.sessions)) {
        for (const s of base.sessions) ids.push(s.id);
      }
      refreshTitles(ids);
      refreshMessages(sessionId);
    }, 800));
  };

  // 广播时机：运行状态翻转 / 摘要文本变化 / 当前会话标题可能变化
  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent;
    if (agent === undefined) return;
    const was = runningBySession.get(agent.id) === true;
    const now = payload.status === 'running';
    runningBySession.set(agent.id, now);
    if (was !== now) server.broadcast();
    if (server.state?.sessionId === agent.id) scheduleTitleRefresh(agent.id);
  });

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent;
    if (agent === undefined) return;
    runningBySession.delete(agent.id);
    server.broadcast();
  });

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return;
    if (server.state?.sessionId === session.id) scheduleTitleRefresh(session.id);
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      const text = textOf(content);
      if (text !== '') {
        summaryBySession.set(session.id, text.length > 180 ? text.slice(0, 180) + '…' : text);
        server.broadcast();
      }
    }
  });

  ctx.on('session/disposed', (session) => {
    summaryBySession.delete(session.id);
    runningBySession.delete(session.id);
    titleBySession.delete(session.id);
    messagesBySession.delete(session.id);
    const timer = titleTimers.get(session.id);
    if (timer !== undefined) { clearTimeout(timer); titleTimers.delete(session.id); }
  });

  ctx.effect(() => {
    let disposed = false;
    let regTimer = null;
    let routeDisposer = null;

    // 同源代理：浏览器无论通过哪种方式访问 GUI（本机/局域网/隧道），
    // 都走 dsh webServer 的同源 /phone-remote/* 路由与局域网服务器互通，
    // 不再依赖浏览器侧的 127.0.0.1 能直达设备端口。
    const bridgeProxy = (method, path) => (req, res) => {
      if (server.port === undefined || server.port === null) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'phone-server-not-started' }));
        return;
      }
      const upstream = http.request({
        host: '127.0.0.1',
        port: server.port,
        method,
        path: `${path}?t=${encodeURIComponent(server.token)}`,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      }, (ures) => {
        if (path === '/bridge/events') {
          // SSE 透传（流式）
          try {
            res.writeHead(ures.statusCode ?? 200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              connection: 'keep-alive',
            });
          } catch { return; }
          res.on('close', () => { try { upstream.destroy(); } catch { /* noop */ } });
          ures.on('data', (chunk) => { try { res.write(chunk); } catch { /* noop */ } });
          ures.on('end', () => { try { res.end(); } catch { /* noop */ } });
          ures.on('error', () => { try { res.end(); } catch { /* noop */ } });
          return;
        }
        // JSON 整包透传
        const chunks = [];
        ures.on('data', (c) => chunks.push(c));
        ures.on('end', () => {
          try {
            res.writeHead(ures.statusCode ?? 200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(Buffer.concat(chunks));
          } catch { /* noop */ }
        });
      });
      upstream.on('error', () => {
        try {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'bridge-unavailable' }));
        } catch { /* noop */ }
      });
      if (method === 'POST') {
        req.on('data', (chunk) => { try { upstream.write(chunk); } catch { /* noop */ } });
        req.on('end', () => { try { upstream.end(); } catch { /* noop */ } });
        req.on('error', () => { try { upstream.destroy(); } catch { /* noop */ } });
      } else {
        upstream.end();
      }
    };

    const registerAll = (webServer) => {
      const disposers = [];
      const register = (path, handler) => disposers.push(webServer.register({ kind: 'exact', path, handler }));
      register('/phone-remote/info', (req, res) => {
        if (server.port === undefined || server.port === null) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'phone-server-not-started' }));
          return;
        }
        const body = JSON.stringify({
          ok: true,
          port: server.port,
          host: server.host ?? '127.0.0.1',
          url: `http://${server.host ?? '127.0.0.1'}:${server.port}/?t=${server.token}`,
          phonesOnline: server.phones.size,
          bridgeOnline: server.bridges.size > 0,
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      });
      register('/phone-remote/token/reset', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'method' }));
          return;
        }
        const fresh = crypto.randomBytes(16).toString('hex');
        try {
          mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
          writeFileSync(TOKEN_FILE, fresh, 'utf8');
        } catch (error) {
          log('error', `令牌重置持久化失败: ${error instanceof Error ? error.message : String(error)}`);
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'persist-failed' }));
          return;
        }
        server.setToken(fresh);
        log('info', '令牌已重置，旧连接全部失效');
        const body = JSON.stringify({
          ok: true,
          port: server.port,
          host: server.host ?? '127.0.0.1',
          url: `http://${server.host ?? '127.0.0.1'}:${server.port}/?t=${fresh}`,
          phonesOnline: server.phones.size,
          bridgeOnline: server.bridges.size > 0,
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      });
      register('/phone-remote/bridge/state', bridgeProxy('POST', '/bridge/state'));
      register('/phone-remote/bridge/pending', bridgeProxy('POST', '/bridge/pending'));
      register('/phone-remote/bridge/events', bridgeProxy('GET', '/bridge/events'));
      return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
    };

    // webServer 可能晚于本插件激活（版本相关挂载顺序差异），轮询等待，
    // 而不是只在启动时试一次；超时后保留局域网直连兜底（客户端会扫端口）。
    const tryRegister = () => {
      if (disposed || routeDisposer !== null) return;
      const webServer = ctx.get('webServer');
      if (webServer === undefined) {
        regTimer = setTimeout(tryRegister, 500);
        return;
      }
      try {
        routeDisposer = registerAll(webServer);
        log('info', '已注册同源 /phone-remote/* 路由');
      } catch (error) {
        log('error', `同源路由注册失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    tryRegister();

    server.start(PREFERRED_PORTS)
      .then(() => {
        log('info', `掌机已启动: http://${server.host ?? '127.0.0.1'}:${server.port}/`);
      })
      .catch((error) => {
        log('error', `掌机服务器启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      disposed = true;
      if (regTimer !== null) clearTimeout(regTimer);
      for (const timer of titleTimers.values()) clearTimeout(timer);
      titleTimers.clear();
      if (routeDisposer !== null) { try { routeDisposer(); } catch { /* noop */ } }
      server.close();
    };
  }, 'dsh-gb: phone server + same-origin routes');
}
