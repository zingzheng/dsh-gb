// dsh-gb — CLIENT 半部源码（由 scripts/build-client.mjs 与 lib/qr.js 一起
// 打包成 window.__ModuleLoader__.load 形式，输出到 lib/client.js）。
// 约束：仅 require('react')；不使用 JSX/TS/import。
//
// 架构：
// - RootBridge（shell.overlay，根作用域常驻）：会话/工作区列表与选择的「根桥」，
//   在 hero / 空白会话 / 切换工作区期间也存活，负责 基础状态推送 + open-* 命令执行。
// - SessionRelay（conversation.composer.dock，会话作用域）：只在有真实会话时挂载，
//   只负责 审批/选择题 carrier 的轻量摘要推送与应答（GUI 同款 PendingWait.respond）。

const React = require('react');

let bridgeBasePromise = null;

function resetBridgeInfo() {
  bridgeBasePromise = null;
}

function hostnameOf() {
  try { return (window.location.hostname || '').trim(); } catch { return ''; }
}

function scanHosts() {
  const hosts = [];
  const h = hostnameOf();
  if (h !== '' && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') hosts.push(h);
  hosts.push('127.0.0.1');
  return hosts;
}

async function scanPort(host) {
  const jobs = [];
  for (let port = 7788; port <= 7795; port++) {
    jobs.push((async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 700);
        const r = await fetch(`http://${host}:${port}/info`, { cache: 'no-store', signal: controller.signal })
          .then((res) => (res.ok ? res.json() : null));
        clearTimeout(timer);
        return (r !== null && r.ok === true) ? { port, url: r.url, token: tokOf(r.url) } : null;
      } catch { return null; }
    })());
  }
  const results = await Promise.all(jobs);
  for (const r of results) if (r !== null) return r;
  return null;
}

/** bridge 端点：同源优先（webServer 代理，任何 GUI 访问方式都可用）；
 *  否则直连扫描到的局域网主机。 */
function endpointOf(base, path) {
  if (base.sameOrigin === true) return '/phone-remote' + path;
  return `http://${base.host}:${base.port}` + path;
}

function fetchInfo() {
  if (bridgeBasePromise !== null) return bridgeBasePromise;
  bridgeBasePromise = (async () => {
    // 1) 同源 /phone-remote/info（dsh webServer 代理）
    const same = await fetch('/phone-remote/info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch((e) => { console.error('[dsh-gb] same-origin info 失败', e); return null; });
    if (same !== null && same.ok === true) {
      console.log('[dsh-gb] info(同源)', JSON.stringify(same));
      return { port: same.port, host: hostnameOf() || '127.0.0.1', token: tokOf(same.url), url: same.url, sameOrigin: true };
    }
    // 2) 扫描：先按页面 hostname（远程访问 GUI 的场景），再本机 127.0.0.1
    for (const host of scanHosts()) {
      const found = await scanPort(host);
      if (found !== null) {
        console.log('[dsh-gb] info(扫描)', host + ':' + found.port);
        return { port: found.port, host, token: found.token, url: found.url, sameOrigin: false };
      }
    }
    console.error('[dsh-gb] 未找到本地掌机服务器');
    return null;
  })();
  return bridgeBasePromise;
}

function tokOf(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('t') ?? '';
  } catch {
    return '';
  }
}

function waitSummary(wait) {
  if (wait === undefined || wait === null) return null;
  const payload = wait.payload ?? {};
  if (wait.kind === 'approval') {
    return {
      kind: 'approval',
      key: wait.key,
      approvalId: payload.approvalId ?? '',
      toolName: payload.toolName ?? '',
      reason: payload.reason ?? '',
    };
  }
  if (wait.kind === 'question') {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const supported = questions.length > 0
      && questions.length <= 8
      && questions.every((q) => q !== null && typeof q === 'object' && q.multiSelect !== true
        && Array.isArray(q.options ? q.options : []) && (q.options.length + 1) <= 9);
    return {
      kind: 'question',
      key: wait.key,
      supported,
      questions: questions.map((q) => {
        const options = Array.isArray(q.options)
          ? q.options.filter((o) => typeof o.label === 'string' && o.label !== '').map((o) => o.label)
          : [];
        return {
          id: q.id ?? 'question',
          text: q.question ?? '',
          options,
          multiSelect: q.multiSelect === true,
        };
      }),
    };
  }
  return null;
}

/** 基础状态：当前选择 + 有序列表（不含 pending）。标题回退链与 web 一致：
 *  展示标题（displayTitle = 持久标题 ?? 工作区目录名 ?? id）。 */
function baseStateOf(sessionsList, workspaceState) {
  const current = sessionsList?.current ?? null;
  const byId = sessionsList?.byId ?? {};
  const visible = (id) => {
    const s = byId[id];
    return s !== undefined && s.blank !== true && s.removed !== true;
  };
  const titleOf = (id) => {
    const s = byId[id];
    if (s === undefined) return id;
    if (typeof s.displayTitle === 'string' && s.displayTitle !== '') return s.displayTitle;
    if (typeof s.title === 'string' && s.title !== '') return s.title;
    return id;
  };
  const items = workspaceState?.items ?? [];
  const currentWorkspace = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(current));
  const workspaceId = currentWorkspace?.workspaceId ?? null;
  const workspaceTitle = currentWorkspace?.title ?? '';
  let sessions;
  if (currentWorkspace !== undefined) {
    sessions = (currentWorkspace.sessionIds ?? []).filter(visible).map((id) => ({ id, title: titleOf(id) }));
  } else {
    sessions = (sessionsList?.ids ?? []).filter(visible).map((id) => ({ id, title: titleOf(id) }));
  }
  const workspaces = items.map((w) => ({ id: w.workspaceId, title: w.title ?? w.path ?? w.workspaceId }));
  const self = byId[current];
  return {
    sessionId: current ?? null,
    sessionTitle: self !== undefined && self.blank !== true ? titleOf(current) : '',
    sessionBlank: self?.blank === true,
    workspaceId,
    workspaceTitle,
    sessions,
    workspaces,
  };
}

function makeSettingsPage() {
  function SettingsPage() {
    const [info, setInfo] = React.useState(null);
    const [error, setError] = React.useState('');
    const refresh = () => {
      setError('');
      fetchInfo().then((base) => {
        if (base === null) {
          setInfo(null);
          setError('未检测到本地掌机服务：请确认插件已成功加载（修改后需重启 dsh）');
          return;
        }
        // 追加实时在线状态（每次重拉，不受 fetchInfo 缓存影响）
        fetch(endpointOf(base, '/info'), { cache: 'no-store' })
          .then((r) => r.json())
          .then((live) => {
            setInfo({
              ...base,
              phonesOnline: live && typeof live.phonesOnline === 'number' ? live.phonesOnline : 0,
              bridgeOnline: live !== null && live !== undefined && live.bridgeOnline === true,
            });
          })
          .catch(() => setInfo(base));
      }).catch(() => setError('信息获取失败'));
    };
    // 打开设置页期间每 3.5s 轮询一次在线状态（手机扫码连接后数字自动更新）
    React.useEffect(() => {
      refresh();
      const timer = setInterval(refresh, 3500);
      return () => clearInterval(timer);
    }, []);
    let svg = '';
    if (info !== null && info.token !== '') {
      try {
        const qr = encodeQr(info.url, 'L');
        svg = qrSvg(qr.lines, qr.size, 4, 4);
      } catch {
        svg = '';
      }
    }
    return React.createElement('div', null,
      React.createElement('style', null, [
        '.dpr-page{display:flex;flex-direction:column;gap:14px;max-width:440px;}',
        '.dpr-qr{background:#fff;border-radius:14px;padding:14px;width:max-content;}',
        '.dpr-qr svg{display:block;width:220px;height:220px;}',
        '.dpr-url{display:flex;gap:8px;align-items:center;}',
        '.dpr-url input{flex:1;min-width:0;font:12px/1.4 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-input-base,#111);color:var(--dsw-alias-label-primary,#eee);}',
        '.dpr-hint{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.8;white-space:pre-line;}',
        '.dpr-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb);display:flex;gap:14px;flex-wrap:wrap;}',
        '.dpr-err{color:var(--dsw-alias-state-error-primary,#f66);font-size:13px;}',
        '.dpr-copy{padding:6px 10px;}',
      ].join('')),
      React.createElement('div', { className: 'dpr-page' },
        info === null
          ? React.createElement('p', { className: 'dpr-err' }, error || '正在获取…')
          : React.createElement(React.Fragment, null,
              React.createElement('h3', null, '① 手机扫码连接（同一局域网）'),
              svg === ''
                ? React.createElement('p', { className: 'dpr-err' }, '二维码生成失败')
                : React.createElement('div', { className: 'dpr-qr', dangerouslySetInnerHTML: { __html: svg } }),
              React.createElement('div', { className: 'dpr-url' },
                React.createElement('input', {
                  readOnly: true,
                  value: info.url,
                  onFocus: (e) => { try { e.target.select(); } catch { /* noop */ } },
                }),
                React.createElement('button', { className: 'dpr-copy', onClick: () => {
                  try { navigator.clipboard.writeText(info.url); } catch { /* noop */ }
                } }, '复制'),
              ),
              React.createElement('div', { className: 'dpr-meta' },
                React.createElement('span', null, '端口 ' + info.port),
                React.createElement('span', null, '手机在线 ' + info.phonesOnline + ' 台'),
                React.createElement('span', null, '浏览器桥：' + (info.bridgeOnline ? '已连接' : '未连接')),
              ),
              React.createElement('div', { className: 'dpr-hint' },
                '② 手机与电脑需处于同一局域网；手机可用自带输入法（如豆包）语音转文字，' +
                '在遥控页发送即可把内容送入当前会话。\n' +
                '③ 若手机打不开页面：请允许 dsh（Node.js）通过 Windows 防火墙（专用网络），' +
                '并检查路由器是否隔离了设备间访问。\n' +
                '④ 令牌随每次 dsh 启动更新，二维码与 URL 请勿外传；页面仅限局域网内访问。',
              ),
              React.createElement('button', { onClick: refresh }, '刷新'),
            ),
      ),
    );
  }
  return SettingsPage;
}

/** 根桥：常驻（shell.overlay），推送基础状态并执行 open-* 命令。 */
function makeRootBridge(sessionsService, workspacesService) {
  function RootBridgeView(props) {
    const lastSnapRef = React.useRef('');
    const timerRef = React.useRef(null);
    const esRef = React.useRef(null);
    const snapRef = React.useRef('');

    // 渲染期组合基础状态（Hook 只能在渲染体内调用）
    const sessionsList = props.useSessions((s) => s);
    const workspaceState = props.useWorkspaces((s) => s);
    let computedJson = '';
    try {
      computedJson = JSON.stringify(baseStateOf(sessionsList, workspaceState));
    } catch {
      computedJson = '';
    }
    snapRef.current = computedJson;
    // 最新快照供命令处理器使用（打开工作区需要选择"最近真实会话"）
    const sessionSnapRef = React.useRef(null);
    sessionSnapRef.current = sessionsList;
    const workspaceSnapRef = React.useRef(null);
    workspaceSnapRef.current = workspaceState;

    // push 只读 refs，可安全在两个 effect 中使用
    const push = () => {
      const json = snapRef.current;
      if (json === '' || json === lastSnapRef.current) return;
      lastSnapRef.current = json;
      fetchInfo().then((base) => {
        if (base === null) return;
        fetch(endpointOf(base, `/bridge/state?t=${encodeURIComponent(base.token)}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
        }).then((r) => r.json()).then((r) => {
          if (!r.ok) console.warn('[dsh-gb] 状态推送被拒', r.error);
        }).catch(() => { resetBridgeInfo(); });
      });
    };

    React.useEffect(() => { push(); }, [computedJson]);

    React.useEffect(() => {
      let closed = false;
      const open = () => {
        fetchInfo().then((base) => {
          if (closed || base === null) return;
          const url = endpointOf(base, `/bridge/events?t=${encodeURIComponent(base.token)}`);
          const es = new EventSource(url);
          esRef.current = es;
          es.addEventListener('cmd', (event) => {
            if (event.data === undefined || event.data === null) return;
            let cmd;
            try { cmd = JSON.parse(event.data); } catch { return; }
            if (cmd.cmd === 'refresh') { push(); return; }
            if (cmd.cmd === 'open-session') {
              try { if (cmd.sessionId) sessionsService.open(cmd.sessionId); } catch { /* noop */ }
              return;
            }
            if (cmd.cmd === 'open-workspace') {
              // 打开目标工作区的"最近真实会话"；无真实会话时回退到新建（新会话）。
              try {
                const wsItems = workspaceSnapRef.current?.items ?? [];
                const ws = wsItems.find((w) => w.workspaceId === cmd.workspaceId);
                const byId = sessionSnapRef.current?.byId ?? {};
                const candidates = (ws?.sessionIds ?? [])
                  .map((id) => byId[id])
                  .filter((s) => s !== undefined && s.blank !== true);
                if (candidates.length > 0) {
                  candidates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
                  sessionsService.open(candidates[0].id);
                  return;
                }
                workspacesService.connectWorkspace(cmd.workspaceId)
                  .then((sid) => sessionsService.open(sid))
                  .catch(() => { /* noop */ });
              } catch { /* noop */ }
              return;
            }
            if (cmd.cmd === 'new-session') {
              // 新建会话：进入目标工作区（默认当前）的新会话流程
              try { workspacesService.startSession(cmd.workspaceId ?? undefined); } catch { /* noop */ }
              return;
            }
          });
          es.onerror = () => {
            resetBridgeInfo();
            try { es.close(); } catch { /* noop */ }
            if (!closed) timerRef.current = setTimeout(open, 3000);
          };
        });
      };
      open();
      return () => {
        closed = true;
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (esRef.current !== null) { try { esRef.current.close(); } catch { /* noop */ } }
      };
    }, []);

    return null;
  }
  return RootBridgeView;
}

/** 会话中继：只在真实会话中挂载，负责审批/题目 carrier 的摘要推送与应答。 */
function makeSessionRelay(sessionsService, workspacesService) {
  function SessionRelayView(props) {
    const session = props.session;
    const waitsRef = React.useRef(new Map());
    const lastPendingRef = React.useRef('');
    const timerRef = React.useRef(null);
    const esRef = React.useRef(null);

    waitsRef.current = new Map();
    for (const wait of session?.pending ?? []) {
      if (wait !== undefined && wait !== null) waitsRef.current.set(wait.key, wait);
    }

    let pendingJson = '';
    if (session !== undefined && session !== null) {
      try {
        pendingJson = JSON.stringify((session.pending ?? []).map(waitSummary).filter((s) => s !== null));
      } catch {
        pendingJson = '';
      }
    }
    const pendingRef = React.useRef('');
    pendingRef.current = pendingJson;

    const pushPending = () => {
      const json = pendingRef.current;
      if (json === lastPendingRef.current) return;
      lastPendingRef.current = json;
      fetchInfo().then((base) => {
        if (base === null) return;
        let parsed;
        try { parsed = JSON.parse(json); } catch { return; }
        fetch(endpointOf(base, `/bridge/pending?t=${encodeURIComponent(base.token)}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pending: parsed }),
        }).then((r) => r.json()).then((r) => {
          if (!r.ok) console.warn('[dsh-gb] pending 推送被拒', r.error);
        }).catch(() => { resetBridgeInfo(); });
      });
    };

    React.useEffect(() => { pushPending(); }, [pendingJson]);

    React.useEffect(() => {
      const handleCommand = (cmd) => {
        if (cmd === undefined || cmd === null) return;
        if (cmd.cmd === 'refresh') { pushPending(); return; }
        if (cmd.cmd === 'approval-answer') {
          const wait = waitsRef.current.get(cmd.key);
          if (wait === undefined) return;
          const outcome = cmd.outcome === 'rejected' ? 'rejected' : 'allowed-once';
          try {
            wait.respond({
              ok: true,
              value: { sessionId: wait.sessionId, approvalId: wait.payload?.approvalId, outcome },
            });
          } catch { /* 已结算 */ }
          return;
        }
        if (cmd.cmd === 'question-answer') {
          const wait = waitsRef.current.get(cmd.key);
          if (wait === undefined) return;
          try {
            wait.respond({
              ok: true,
              value: { sessionId: wait.sessionId, answer: { answers: cmd.answers } },
            });
          } catch { /* 已结算 */ }
          return;
        }
      };
      let closed = false;
      const open = () => {
        fetchInfo().then((base) => {
          if (closed || base === null) return;
          const url = endpointOf(base, `/bridge/events?t=${encodeURIComponent(base.token)}`);
          const es = new EventSource(url);
          esRef.current = es;
          es.addEventListener('cmd', (event) => {
            if (event.data === undefined || event.data === null) return;
            let cmd;
            try { cmd = JSON.parse(event.data); } catch { return; }
            handleCommand(cmd);
          });
          es.onerror = () => {
            resetBridgeInfo();
            try { es.close(); } catch { /* noop */ }
            if (!closed) timerRef.current = setTimeout(open, 3000);
          };
        });
      };
      open();
      return () => {
        closed = true;
        if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (esRef.current !== null) { try { esRef.current.close(); } catch { /* noop */ } }
      };
    }, []);

    return null;
  }
  return SessionRelayView;
}

function apply(ctx) {
  const slots = ctx.get('slots');
  if (slots === undefined) return;
  const sessionsService = ctx.get('sessions');
  const workspacesService = ctx.get('workspaces');

  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: 'dsh-gb',
      order: 500,
      label: '掌机',
    },
    makeSettingsPage(),
  ));

  slots.inject('shell.overlay', () => slots.register(
    {
      name: 'shell.overlay',
      id: 'dsh-gb',
      order: 800,
      label: '',
    },
    makeRootBridge(sessionsService, workspacesService),
  ));

  slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: 'dsh-gb',
      order: 50,
      label: '',
    },
    makeSessionRelay(sessionsService, workspacesService),
  ));
}

const inject = ['slots', 'sessions', 'workspaces'];
