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
      if (typeof same.url === 'string' && same.url !== '') {
        return { port: same.port, host: hostnameOf() || '127.0.0.1', token: tokOf(same.url), url: same.url, sameOrigin: true, restricted: false };
      }
      // 同源信息被脱敏（GUI 被局域网/远程直接访问）：先尝试本机扫描兜底（二维码仍可用），
      // 否则进入只读状态模式（看不到二维码/令牌，bridge 由代理注入令牌仍可工作）
      for (const host of scanHosts()) {
        const found = await scanPort(host);
        if (found !== null) {
          console.log('[dsh-gb] info(脱敏回退扫描)', host + ':' + found.port);
          return { port: found.port, host, token: found.token, url: found.url, sameOrigin: false, restricted: false };
        }
      }
      console.warn('[dsh-gb] 同源信息为脱敏模式且本机扫描不可达（远程/局域网只读）');
      return { port: same.port, host: hostnameOf() || '127.0.0.1', token: '', url: null, sameOrigin: true, restricted: true };
    }
    // 2) 扫描：先按页面 hostname（远程访问 GUI 的场景），再本机 127.0.0.1
    for (const host of scanHosts()) {
      const found = await scanPort(host);
      if (found !== null) {
        console.log('[dsh-gb] info(扫描)', host + ':' + found.port);
        return { port: found.port, host, token: found.token, url: found.url, sameOrigin: false, restricted: false };
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

function tunnelStatusText(info) {
  const t = info.tunnel;
  if (t === null || t === undefined) return '隧道：未启用';
  const label = t.state === 'off' ? '未开启' : t.state === 'running' ? '运行中' : t.state === 'starting' ? '启动中…' : '失败';
  let s = '隧道：' + label + (t.mode === 'named' ? '（命名）' : t.mode === 'quick' ? '（快速）' : '');
  if (t.url) s += ' · ' + t.url;
  if (t.error) s += ' · ' + t.error;
  return s;
}

/** 问号悬浮提示（无依赖 CSS tooltip；hover / 聚焦弹出，移动端点按亦可）。 */
function Tip(props) {
  return React.createElement('span', { className: 'dpr-tip', tabIndex: 0, 'aria-label': props.text },
    '?',
    React.createElement('span', { className: 'dpr-tip-box' }, props.text));
}

const LAN_TIP = '手机与电脑需处于同一局域网（同一 Wi-Fi）。\n若手机打不开页面：允许 dsh（Node.js）通过 Windows 防火墙（专用网络），并检查路由器是否开启了 AP 隔离。\n语音输入：用手机自带输入法（如豆包）的语音转文字，在遥控页发送即可送入当前会话。';
const PUBLIC_TIP = '隧道地址是公开的，鉴权唯一依赖 URL 里的随机令牌——请勿外传；令牌可在「重置令牌」一键作废。\n快速隧道地址在 dsh 重启后会变化（重新扫码即可）；要固定地址请用「命名隧道」。\n部分隧道（如 Cloudflare 快速隧道）不支持实时推送，页面会自动切换为轮询模式（约 2.5s 刷新）。\n语音输入：用手机自带输入法（如豆包）的语音转文字，在遥控页发送即可送入当前会话。';
const TOKEN_TIP = '令牌首次启动生成并持久化（~/.dsh/dsh-gb.token），重启 dsh 不变，收藏的地址长期有效；点击「重置令牌」一键作废全部旧链接（需重新扫码）。';
const TUNNEL_TYPE_TIP = '快速隧道：零账号零配置，地址临时（dsh 重启后变化，重新扫码即可）。\n命名隧道：用你自己的域名，地址永久固定；需在 Cloudflare 控制台先建好隧道。';
const TUNNEL_TOKEN_TIP = 'Cloudflare 控制台 → Networks → Tunnels → 创建隧道 → 复制 Token 填入。\n公共主机名映射到 http://127.0.0.1:<掌机端口>（默认 7788）。';
const TUNNEL_DOMAIN_TIP = '填写上面配置的公共主机名（https:// 开头），例如 https://dsh.example.com——必须与 Token 对应的主机名一致。';
const TUNNEL_DL_TIP = '首次启用公网模式时自动下载 cloudflared（约 30-60MB，缓存于 ~/.dsh/cache，仅一次）；\n下载失败会在状态区给出原因并自动重试；受限网络可用环境变量 DSH_GB_CLOUDFLARED_URL 换镜像源。';

function makeSettingsPage() {
  function SettingsPage() {
    const [info, setInfo] = React.useState(null);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [tunnelCfg, setTunnelCfg] = React.useState(null);
    const [tunnelBusy, setTunnelBusy] = React.useState(false);
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
              // url/port 以实时 /info 为准（隧道切换后 QR 立即跟随生效地址；base 只是回退）
              url: live && typeof live.url === 'string' && live.url !== '' ? live.url : base.url,
              port: live && typeof live.port === 'number' ? live.port : base.port,
              phonesOnline: live && typeof live.phonesOnline === 'number' ? live.phonesOnline : 0,
              bridgeOnline: live !== null && live !== undefined && live.bridgeOnline === true,
              tunnel: live && typeof live.tunnel === 'object' && live.tunnel !== null ? live.tunnel : null,
              restricted: typeof (live && live.restricted) === 'boolean' ? live.restricted : (base.restricted === true),
            });
          })
          .catch(() => setInfo(base));
      }).catch(() => setError('信息获取失败'));
    };
    // 打开设置页期间每 3.5s 轮询一次在线状态（手机扫码连接后数字自动更新）；
    // 隧道配置只加载一次（避免轮询覆盖用户正在编辑的表单）
    React.useEffect(() => {
      refresh();
      fetch('/phone-remote/tunnel', { cache: 'no-store' })
        .then((r) => r.json())
        .then((r) => {
          if (r !== null && r !== undefined && r.ok === true && r.config !== undefined) {
            setTunnelCfg({
              enabled: r.config.enabled === true,
              mode: r.config.mode === 'named' ? 'named' : 'quick',
              token: typeof r.config.token === 'string' ? r.config.token : '',
              publicHost: typeof r.config.publicHost === 'string' ? r.config.publicHost : '',
            });
          }
        })
        .catch(() => { /* 无隧道端点（旧版本）时忽略 */ });
      const timer = setInterval(refresh, 3500);
      return () => clearInterval(timer);
    }, []);
    const applyTunnelBody = (body) => {
      if (body === null || body === undefined || tunnelBusy) return;
      setTunnelBusy(true);
      setError('');
      fetch('/phone-remote/tunnel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()).then((r) => {
        setTunnelBusy(false);
        if (r !== null && r !== undefined && r.ok === true) {
          setNotice(body.enabled ? '已切换到公网模式（公网地址就绪前约需 10-30 秒）' : '已切换到内网模式');
          refresh();
        } else {
          setError('配置失败：' + ((r && r.error) || '未知错误'));
        }
      }).catch(() => { setTunnelBusy(false); setError('配置失败：网络错误'); });
    };
    const applyTunnel = () => { if (tunnelCfg !== null) applyTunnelBody(tunnelCfg); };
    /** 顶部模式切换：内网/公网。点击即应用（enabled）；命名隧道未配置完整时先只切视图并提示。 */
    const switchMode = (enabled) => {
      if (tunnelCfg === null || tunnelBusy) return;
      if (enabled === tunnelCfg.enabled) return;
      const next = { ...tunnelCfg, enabled };
      setTunnelCfg(next);
      if (enabled && next.mode === 'named' && (next.token === '' || next.publicHost === '')) {
        setNotice('公网模式：请先填写下方命名隧道的 Token 与域名，再点「应用设置」');
        return;
      }
      applyTunnelBody(next);
    };
    // ── 模式视图状态：内网=隧道关（二维码=局域网地址）；公网=隧道开（二维码=实际生效地址）──
    const publicMode = tunnelCfg !== null && tunnelCfg.enabled === true;
    const tunnelState = info === null ? null : info.tunnel;
    const tunnelRunning = tunnelState !== null && tunnelState.state === 'running';
    // 公网但隧道未就绪时不展示地址（避免「切了公网却还是内网二维码」的割裂感）
    let qrUrl = null;
    if (info !== null && info.restricted !== true) {
      qrUrl = publicMode ? (tunnelRunning ? info.url : null) : info.url;
    }
    let svg = '';
    let qrErr = '';
    if (info !== null && info.token !== '' && qrUrl !== null) {
      try {
        const qr = encodeQr(qrUrl, 'L');
        svg = qrSvg(qr.lines, qr.size, 4, 4);
      } catch (e) {
        svg = '';
        qrErr = (e !== null && e !== undefined && e.message) || '二维码生成失败（内容可能过长）';
      }
    }
    let qrPlaceholder = '二维码生成失败';
    if (info !== null && info.restricted === true) qrPlaceholder = '二维码不可用：请在本机打开设置页获取';
    else if (publicMode && !tunnelRunning) qrPlaceholder = '公网地址未就绪：隧道启动中或失败（见上方状态），就绪后自动更新二维码';
    else if (qrErr !== '') qrPlaceholder = qrErr;
    return React.createElement('div', null,
      React.createElement('style', null, [
        '.dpr-page{display:flex;flex-direction:column;gap:14px;max-width:440px;}',
        '.dpr-brand{display:flex;align-items:center;justify-content:center;gap:10px;font:800 18px/1.2 ui-monospace,"Courier New",monospace;color:var(--dsw-alias-label-primary,#eee);}',
        '.dpr-brand span{letter-spacing:6px;}',
        '.dpr-qr{background:#fff;border-radius:14px;padding:14px;width:max-content;}',
        '.dpr-qr svg{display:block;width:220px;height:220px;}',
        '.dpr-url{display:flex;gap:8px;align-items:center;}',
        '.dpr-url input,.dpr-tin{flex:1;min-width:0;font:12px/1.4 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#333);background:var(--dsw-specific-input-base,#111);color:var(--dsw-alias-label-primary,#eee);}',
        '.dpr-mode{display:flex;gap:8px;}',
        '.dpr-mode-btn{flex:1;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#333);background:transparent;color:var(--dsw-alias-label-secondary,#bbb);cursor:pointer;font-weight:600;font-size:12.5px;}',
        '.dpr-mode-btn.on{background:#2f7d52;border-color:transparent;color:#fff;}',
        '.dpr-mode-btn:disabled{opacity:.4;cursor:default;}',
        '.dpr-tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#555);color:var(--dsw-alias-label-tertiary,#999);font:700 10px/1 ui-monospace,Consolas,monospace;cursor:help;vertical-align:middle;flex:0 0 auto;}',
        '.dpr-tip-box{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);width:max-content;max-width:250px;background:rgba(16,16,14,.98);border:1px solid var(--dsw-alias-border-l2,#444);color:var(--dsw-alias-label-primary,#ddd);font:12px/1.7 -apple-system,"Segoe UI",sans-serif;padding:8px 10px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .12s;z-index:30;white-space:pre-line;text-align:left;}',
        '.dpr-tip:hover .dpr-tip-box,.dpr-tip:focus .dpr-tip-box{opacity:1;}',
        '.dpr-row{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#bbb);}',
        '.dpr-tunnel{display:flex;flex-direction:column;gap:9px;border-top:1px solid var(--dsw-alias-border-l2,#333);padding-top:10px;margin-top:4px;}',
        '.dpr-hint{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.8;white-space:pre-line;}',
        '.dpr-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#bbb);display:flex;gap:14px;flex-wrap:wrap;}',
        '.dpr-err{color:var(--dsw-alias-state-error-primary,#f66);font-size:13px;}',
        '.dpr-ok{color:#7fc97f;font-size:13px;}',
        '.dpr-copy{padding:6px 10px;}',
        '.dpr-reset{padding:6px 10px;color:var(--dsw-alias-state-error-primary,#f66);border:1px solid currentColor;background:transparent;}',
      ].join('')),
      React.createElement('div', { className: 'dpr-page' },
        React.createElement('div', { className: 'dpr-brand' },
          React.createElement('svg', { viewBox: '0 0 48 48', width: 38, height: 38, 'aria-hidden': true },
            React.createElement('rect', { x: 4, y: 2, width: 40, height: 44, rx: 7, fill: '#b9b2a0', stroke: '#2c2b27', strokeWidth: 2 }),
            React.createElement('rect', { x: 9, y: 7, width: 30, height: 18, rx: 2, fill: '#9bbc0f', stroke: '#0f380f', strokeWidth: 1.5 }),
            React.createElement('text', { x: 24, y: 20.5, fontSize: 7, fill: '#0f380f', textAnchor: 'middle', fontFamily: 'ui-monospace,"Courier New",monospace' }, 'DSH'),
            React.createElement('circle', { cx: 14, cy: 33.5, r: 1.8, fill: '#2c2b27' }),
            React.createElement('circle', { cx: 20, cy: 33.5, r: 1.8, fill: '#2c2b27' }),
            React.createElement('circle', { cx: 26, cy: 33.5, r: 1.8, fill: '#2c2b27' }),
            React.createElement('rect', { x: 11, y: 38, width: 13, height: 4.5, rx: 1, fill: '#2c2b27' }),
            React.createElement('rect', { x: 31, y: 36.5, width: 5, height: 6, rx: 1.2, fill: '#2c2b27' }),
            React.createElement('rect', { x: 37.5, y: 34.5, width: 4.5, height: 9.5, rx: 1.2, fill: '#2c2b27' }),
          ),
          React.createElement('span', null, 'DSH 掌机'),
        ),
        info === null
          ? React.createElement('p', { className: 'dpr-err' }, error || '正在获取…')
          : React.createElement(React.Fragment, null,
              info.restricted === true
                ? React.createElement('p', { className: 'dpr-hint' }, '⚠ 当前为非本机来源（局域网/远程）：仅显示状态；二维码、令牌重置、隧道配置仅限在本机打开本设置页使用。')
                : null,
              // ── 顶部模式切换：内网（默认）/ 公网 ──
              tunnelCfg === null || info.restricted === true
                ? null
                : React.createElement('div', { className: 'dpr-mode' },
                    React.createElement('button', { className: 'dpr-mode-btn' + (publicMode ? '' : ' on'),
                      'aria-pressed': !publicMode, disabled: tunnelBusy,
                      onClick: () => switchMode(false) }, '内网模式'),
                    React.createElement('button', { className: 'dpr-mode-btn' + (publicMode ? ' on' : ''),
                      'aria-pressed': publicMode, disabled: tunnelBusy,
                      onClick: () => switchMode(true) }, '公网模式'),
                  ),
              // ── 公网模式才出现：隧道配置 ──
              publicMode && tunnelCfg !== null && info.restricted !== true
                ? React.createElement('div', { className: 'dpr-tunnel' },
                    React.createElement('p', { className: 'dpr-meta' }, tunnelStatusText(info)),
                    React.createElement('div', { className: 'dpr-row' },
                      React.createElement('span', null, '隧道类型'),
                      React.createElement('select', { value: tunnelCfg.mode, disabled: tunnelBusy,
                        onChange: (e) => setTunnelCfg({ ...tunnelCfg, mode: e.target.value }) },
                        React.createElement('option', { value: 'quick' }, '快速隧道（临时地址，零配置）'),
                        React.createElement('option', { value: 'named' }, '命名隧道（固定域名）'),
                      ),
                      React.createElement(Tip, { text: TUNNEL_TYPE_TIP }),
                    ),
                    tunnelCfg.mode === 'named'
                      ? React.createElement(React.Fragment, null,
                          React.createElement('div', { className: 'dpr-row' },
                            React.createElement('span', null, 'Token'),
                            React.createElement('input', { className: 'dpr-tin', type: 'password',
                              value: tunnelCfg.token, placeholder: 'cloudflared 命名隧道 Token',
                              onChange: (e) => setTunnelCfg({ ...tunnelCfg, token: e.target.value }) }),
                            React.createElement(Tip, { text: TUNNEL_TOKEN_TIP }),
                          ),
                          React.createElement('div', { className: 'dpr-row' },
                            React.createElement('span', null, '域名'),
                            React.createElement('input', { className: 'dpr-tin',
                              value: tunnelCfg.publicHost, placeholder: 'https://dsh.example.com',
                              onChange: (e) => setTunnelCfg({ ...tunnelCfg, publicHost: e.target.value }) }),
                            React.createElement(Tip, { text: TUNNEL_DOMAIN_TIP }),
                          ),
                        )
                      : null,
                    React.createElement('div', { className: 'dpr-row' },
                      React.createElement('button', { disabled: tunnelBusy, onClick: applyTunnel }, '应用设置'),
                      React.createElement('span', null, '首次启用自动下载 cloudflared（约 30-60MB，仅一次）',
                        React.createElement(Tip, { text: TUNNEL_DL_TIP })),
                    ),
                  )
                : null,
              React.createElement('h3', null, '手机扫码连接', React.createElement(Tip, { text: TOKEN_TIP })),
              React.createElement('p', { className: 'dpr-meta' },
                React.createElement('span', null,
                  publicMode ? '公网：任意网络（4G / 异地 Wi-Fi）扫码即连' : '内网：手机与电脑同一局域网（同一 Wi-Fi）扫码即连',
                  React.createElement(Tip, { text: publicMode ? PUBLIC_TIP : LAN_TIP }),
                ),
              ),
              svg === ''
                ? React.createElement('p', { className: 'dpr-err' }, qrPlaceholder)
                : React.createElement('div', { className: 'dpr-qr', dangerouslySetInnerHTML: { __html: svg } }),
              React.createElement('div', { className: 'dpr-url' },
                React.createElement('input', {
                  readOnly: true,
                  value: qrUrl === null || qrUrl === undefined ? '' : qrUrl,
                  placeholder: publicMode && !tunnelRunning ? '等待公网地址就绪…' : '',
                  onFocus: (e) => { try { e.target.select(); } catch { /* noop */ } },
                }),
                React.createElement('button', { className: 'dpr-copy', onClick: () => {
                  try { if (qrUrl) navigator.clipboard.writeText(qrUrl); } catch { /* noop */ }
                } }, '复制'),
              ),
              React.createElement('div', { className: 'dpr-meta' },
                React.createElement('span', null, '端口 ' + info.port),
                React.createElement('span', null, '手机在线 ' + info.phonesOnline + ' 台'),
                React.createElement('span', null, '浏览器桥：' + (info.bridgeOnline ? '已连接' : '未连接')),
              ),
              notice === '' ? null : React.createElement('p', { className: 'dpr-ok' }, notice),
              React.createElement('div', { className: 'dpr-meta' },
                React.createElement('button', { onClick: refresh }, '刷新'),
                info.restricted === true
                  ? null
                  : React.createElement('button', { className: 'dpr-reset', onClick: () => {
                      let ok = false;
                      try { ok = window.confirm('重置令牌：所有旧二维码/链接立即失效，需重新扫码。确定？'); } catch { ok = false; }
                      if (!ok) return;
                      fetch('/phone-remote/token/reset', { method: 'POST' })
                        .then((r) => r.json())
                        .then((r) => {
                          if (r !== null && r !== undefined && r.ok === true) {
                            resetBridgeInfo();
                            setNotice('已重置令牌：旧二维码/链接已失效，请用新二维码重新连接');
                            refresh();
                          } else {
                            setError('重置失败：' + ((r && r.error) || '未知错误'));
                          }
                        })
                        .catch(() => setError('重置失败：网络错误'));
                    } }, '重置令牌'),
              ),
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
