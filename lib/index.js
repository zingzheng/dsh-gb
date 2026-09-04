// dsh-gb — HOST 半部：cordis 插件入口。
// 负责：0.0.0.0 局域网 HTTP 服务器（页面 / SSE / API）、令牌、LAN IP 探测、
// 会话事件监听（运行状态 + 一句话总结）、GUI 浏览器同源 /info 路由。
import os from 'node:os';
import crypto from 'node:crypto';
import { PhoneRemoteServer } from './server-core.js';
import { phonePageHtml } from './phone-page.js';

export const name = 'dsh-gb';

const PREFERRED_PORTS = [7788, 7789, 7790, 7791, 7792, 7793, 7794, 7795];

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
  const private_ = candidates.filter((ip) =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  return private_[0] ?? candidates[0] ?? null;
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out.replace(/\s+/g, ' ').trim();
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
  });
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
    let closed = false;
    let routeDisposer = null;
    const registerInfoRoute = () => {
      if (routeDisposer !== null) return;
      const webServer = ctx.get('webServer');
      if (webServer === undefined) return;
      routeDisposer = webServer.register({
        kind: 'exact',
        path: '/phone-remote/info',
        handler: (req, res) => {
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
        },
      });
      log('info', '已注册同源 /phone-remote/info 路由');
    };
    registerInfoRoute();
    server.start(PREFERRED_PORTS)
      .then(() => {
        log('info', `掌机已启动: http://${server.host ?? '127.0.0.1'}:${server.port}/`);
        // webServer 可能晚于本插件挂载，启动后补挂一次信息路由
        registerInfoRoute();
      })
      .catch((error) => {
        log('error', `掌机服务器启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      if (closed) return;
      closed = true;
      for (const timer of titleTimers.values()) clearTimeout(timer);
      titleTimers.clear();
      if (routeDisposer !== null) { try { routeDisposer(); } catch { /* noop */ } }
      server.close();
    };
  }, 'dsh-gb: phone server + same-origin info route');
}
