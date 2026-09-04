// dsh-gb — 掌机页面（Game Boy 风格，单文件、无外部依赖）。
// v2 布局：屏幕在上（全宽大 LCD）、输入框在下、底部按键区（摇杆 | A/B/YES/NO）。
// 摇杆：选择题模式 = ↑↓ 选项 / ←→ 题目；普通模式 = ↑↓ 滚动屏内文本 / ←→ 上一条/下一条消息。
// 页面 JS 刻意避免模板字符串与 ${ 序列，便于嵌入 host 模板字面量。
export const phonePageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#b9b2a0">
<title>DSH 掌机</title>
<style>
:root { --shell:#b9b2a0; --shell2:#a49d8b; --bezel:#45443e; --frame:#2c2b27; --lcd:#9bbc0f; --lcd-fg:#0f380f; --lcd-mid:#6b8e0a;
  --btn:#d0cabc; --btn2:#b3ac9a; --ink:#2c2b27; --ink2:#5c584c; --ok:#2f7d52; --bad:#8a3b3b;
  -webkit-tap-highlight-color: transparent; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { background: #7d7768; color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  padding: max(8px, env(safe-area-inset-top)) 10px max(10px, env(safe-area-inset-bottom));
  display: flex; align-items: center; justify-content: center; }
#gbshell { width: 100%; max-width: 420px; background: linear-gradient(180deg, var(--shell) 0%, var(--shell2) 100%);
  border-radius: 24px; padding: 12px 12px 14px; box-shadow: 0 18px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.35);
  display: flex; flex-direction: column; gap: 9px; }

/* 顶部：标题 + 工作区/会话下拉 */
.topbar { text-align: center; }
.topbar .name { font: 800 18px/1.2 ui-monospace, "Courier New", monospace; letter-spacing: 4px; color: #5a3f2b; }
.topbar .name b { color: #7a3d2e; }
.ddrow { display: flex; gap: 6px; margin-top: 7px; }
.dd { flex: 1; min-width: 0; }
.dd label { display: block; font-size: 9.5px; letter-spacing: 1px; color: var(--ink2); margin-bottom: 2px; text-align: left; padding-left: 2px; }
select { width: 100%; height: 34px; -webkit-appearance: none; appearance: none; background: var(--lcd);
  border: 2px solid var(--frame); border-radius: 6px; color: var(--lcd-fg); font: 700 16px/1 ui-monospace, "Courier New", monospace;
  padding: 0 8px; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
select:focus { outline: 2px solid #2b4d1f; }

/* 屏幕区（bezel 内：全宽 LCD） */
.screenwrap { background: var(--bezel); border-radius: 18px; padding: 10px 10px 12px; box-shadow: inset 0 2px 8px rgba(0,0,0,.55); }
.lcd { background: var(--lcd); border: 2px solid var(--frame); border-radius: 6px;
  color: var(--lcd-fg); font: 13px/1.6 ui-monospace, "Courier New", monospace; padding: 8px 9px;
  height: 236px; overflow: hidden; position: relative; }
.lcd .scanner { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgba(6,42,6,.05) 0 1px, transparent 1px 3px); pointer-events: none; }
.lcd .content { height: 100%; overflow: hidden; }
.lcd .cursor { animation: blink 1s steps(1) infinite; }
.lcd .blink { animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.lcd .row { white-space: pre-wrap; word-break: break-all; }
.lcd .dim { color: var(--lcd-mid); }
.lcd .inv { font-weight: 700; }
.lcd .stat { letter-spacing: 1px; margin-bottom: 3px; }
.lcd .title { font-weight: 700; }
.lcd .navline { font-size: 11px; letter-spacing: 1px; color: var(--lcd-mid); margin-top: 4px; }

/* 输入区（屏幕下方全宽） */
.inbox { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
textarea { width: 100%; height: 88px; resize: none; background: #23221e;
  border: 2px solid var(--frame); border-radius: 10px; color: #e4e2d6; font: 16px/1.5 ui-monospace, "Courier New", monospace;
  padding: 10px 12px; }
textarea::placeholder { color: #88846f; }
textarea:focus { outline: none; border-color: #6b6a5c; }
.inbox .phase { font: 10px/1.3 ui-monospace, "Courier New", monospace; color: #ddd8c8; letter-spacing: 1px; text-align: center; }

/* 底部按键区 */
.padwrap { display: flex; gap: 12px; align-items: stretch; padding: 12px 4px 2px; }
.dpadwrap { flex: 1 1 44%; }
.dpad { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); gap: 6px; aspect-ratio: 1; }
.dbtn { border-radius: 12px; background: linear-gradient(180deg, var(--btn), var(--btn2)); border: 2px solid var(--frame);
  color: var(--ink); font: 800 21px/1 ui-monospace, "Courier New", monospace; cursor: pointer; min-height: 0; }
.dbtn:active { background: var(--btn2); transform: translateY(1px); }
.dpad .center { display: flex; align-items: center; justify-content: center; }

.abwrap { flex: 1 1 56%; display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.bbtn { border-radius: 13px; border: 2px solid var(--frame); background: linear-gradient(180deg, var(--btn), var(--btn2));
  min-height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; color: var(--ink); }
.bbtn small { font-size: 9.5px; letter-spacing: 1px; color: var(--ink2); font-weight: 400; }
.bbtn b { font: 800 17px/1 ui-monospace, "Courier New", monospace; }
.bbtn:active { transform: translateY(1px); }
.bbtn.send b { font-size: 20px; }
.bbtn.yes { background: linear-gradient(180deg, #1f4f38, #173a2a); color: #b6e6c8; }
.bbtn.yes small { color: #9fcab0; }
.bbtn.no { background: linear-gradient(180deg, #5c2626, #451c1c); color: #eab4b4; }
.bbtn.no small { color: #c99090; }
.bbtn:disabled { opacity: .35; cursor: default; }
.bbtn.pulse { animation: glow 1s ease-in-out infinite; }
@keyframes glow { 50% { box-shadow: 0 0 10px rgba(255,220,80,.55); } }

.toast { position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%); max-width: 86%;
  background: rgba(24,24,20,.96); border: 1px solid #6b6a5c; color: #e4e2d6; padding: 9px 16px; border-radius: 999px;
  font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .25s; z-index: 9; text-align: center; }
.toast.show { opacity: 1; }
.toast.ok { border-color: #2f7d52; color: #9fe0b8; }
.toast.err { border-color: #8a3b3b; color: #f0b0b0; }
</style>
</head>
<body>
<div id="gbshell">
  <div class="topbar">
    <div class="name">DSH <b>遥控</b></div>
    <div class="ddrow">
      <div class="dd"><label>工作区</label><select id="wsSel"></select></div>
      <div class="dd"><label>会话</label><select id="sessSel"></select></div>
    </div>
  </div>

  <div class="screenwrap">
    <div class="lcd">
      <div class="content" id="lcdContent"><div id="lcdInner"><div class="row dim">正在连接……</div></div></div>
      <div class="scanner"></div>
    </div>
    <div class="inbox">
      <textarea id="input" placeholder="用手机输入法语音转文字…"></textarea>
      <div class="phase" id="phase">←→ 消息 · ↑↓ 滚动 · A 发送</div>
    </div>
  </div>

  <div class="padwrap">
    <div class="dpadwrap">
      <div class="dpad">
        <span></span>
        <button class="dbtn" id="dUp" aria-label="上">↑</button>
        <span></span>
        <button class="dbtn" id="dLeft" aria-label="左">←</button>
        <div class="center"></div>
        <button class="dbtn" id="dRight" aria-label="右">→</button>
        <span></span>
        <button class="dbtn" id="dDown" aria-label="下">↓</button>
        <span></span>
      </div>
    </div>
    <div class="abwrap">
      <button class="bbtn send" id="btnSend"><b>A</b><small>发送</small></button>
      <button class="bbtn" id="btnPause"><b>B</b><small>暂停</small></button>
      <button class="bbtn yes" id="btnYes"><b>YES</b><small>允许一次</small></button>
      <button class="bbtn no" id="btnNo"><b>NO</b><small>拒绝</small></button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || '';
  var state = { connected: false };
  var qIndex = 0;            // 当前题目序号
  var sel = [];              // 每题所选选项下标（-1 = 未选择）
  var custom = {};           // 每题自定义答案
  var lastQKey = '';
  var msgIndex = -1;         // 当前查看的消息下标（-1 = 未浏览）
  var prevMsgCount = 0;
  var scrollOff = 0;         // 当前滚动偏移（像素）
  var toastTimer = null;
  var SCROLL_STEP = 42;

  function $ (id) { return document.getElementById(id); }
  function showToast(text, kind) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 1800);
  }
  function beep() { showToast('哔——', 'err'); }

  // 滚动采用 margin-top 负偏移（iOS Safari 不响应 overflow:hidden 容器的 scrollTop，
  // 改为自己管理偏移，各平台一致）。
  function maxScroll() {
    var outer = $('lcdContent');
    var inner = $('lcdInner');
    if (outer === null || inner === null) return 0;
    var m = inner.scrollHeight - outer.clientHeight;
    return m > 0 ? m : 0;
  }
  function applyScroll() {
    var inner = $('lcdInner');
    if (inner === null) return;
    inner.style.marginTop = (-scrollOff) + 'px';
  }
  function viewScroll(newOff) {
    var max = maxScroll();
    if (max === 0) return;
    scrollOff = newOff < 0 ? 0 : newOff > max ? max : newOff;
    applyScroll();
  }

  function api(payload, okText, errText) {
    if (token === '') { showToast('缺少令牌', 'err'); return Promise.resolve({ ok: false }); }
    return fetch('/api?t=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) { if (okText) showToast(okText, 'ok'); }
      else { showToast((errText ? errText + '：' : '失败：') + (r.error || '未知错误'), 'err'); }
      return r;
    }).catch(function () { showToast(errText || '网络错误', 'err'); return { ok: false }; });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    renderDrops();
    renderLcd();
    renderPad();
  }

  function renderDrops() {
    var ws = $('wsSel');
    var itemsWs = state.workspaces || [];
    ws.textContent = '';
    for (var i = 0; i < itemsWs.length; i++) {
      var o = document.createElement('option');
      o.value = itemsWs[i].id;
      o.textContent = itemsWs[i].title || '（未命名）';
      if (itemsWs[i].id === state.workspaceId) o.selected = true;
      ws.appendChild(o);
    }

    var ss = $('sessSel');
    var itemsS = state.sessions || [];
    ss.textContent = '';
    var optNew = document.createElement('option');
    optNew.value = '__new__';
    optNew.textContent = '＋ 新建会话';
    ss.appendChild(optNew);
    for (var j = 0; j < itemsS.length; j++) {
      var o2 = document.createElement('option');
      o2.value = itemsS[j].id;
      o2.textContent = itemsS[j].title || '（未命名）';
      if (itemsS[j].id === state.sessionId) o2.selected = true;
      ss.appendChild(o2);
    }
  }

  function currentMessage() {
    var msgs = state.messages || [];
    if (msgs.length === 0) return null;
    var i = msgIndex >= 0 && msgIndex < msgs.length ? msgIndex : msgs.length - 1;
    return { index: i, msg: msgs[i] };
  }

  function renderLcd() {
    var box = $('lcdInner');
    if (box === null) return;
    if (!state.connected) { box.innerHTML = '<div class="row dim">× 未连接</div>'; return; }
    if (state.pendingApproval) {
      box.innerHTML = '';
      addLine(box, 'div', 'stat inv', '▼ 待审批');
      addLine(box, 'div', 'row', '工具: ' + esc(state.approvalTool || '未知'));
      if (state.approvalReason) addLine(box, 'div', 'row', esc(state.approvalReason));
      addLine(box, 'div', 'row dim', 'YES=允许一次 NO=拒绝');
      return;
    }
    if (state.pendingQuestion) {
      box.innerHTML = '';
      var qs = state.questions || [];
      if (qs.length === 0) { addLine(box, 'div', 'row dim', '（题目加载中…）'); return; }
      var q = qs[qIndex];
      if (!q) { qIndex = 0; q = qs[0]; }
      addLine(box, 'div', 'stat', 'Q ' + (qIndex + 1) + '/' + qs.length + ' · 题');
      addLine(box, 'div', 'title', esc(q.text || '（无标题）'));
      var opts = q.options || [];
      if (state.questionSupported === false) {
        addLine(box, 'div', 'row dim', '含多选/多题，请到电脑端作答');
      } else if (opts.length === 0) {
        addLine(box, 'div', 'row dim', '本题无选项，请在下方面板输入答案后按 A');
      } else {
        for (var i = 0; i < opts.length; i++) {
          var mark = i === sel[qIndex] ? '▶ ' : '  ';
          addLine(box, 'div', 'row', mark + esc(opts[i]));
        }
      }
      if (custom[q.id]) addLine(box, 'div', 'row dim', '已填自定义答案');
      return;
    }
    // 普通模式：单条完整消息视图（←→ 切换上下一条 / ↑↓ 滚动查看全文）
    box.innerHTML = '';
    var running = state.status === 'running';
    var cur = currentMessage();
    var msgs = state.messages || [];
    var statLine = running ? '● 运行中' : '○ 空闲';
    if (cur !== null) statLine += '  ·  ‹ 第 ' + (cur.index + 1) + '/' + msgs.length + ' 条 ›';
    // 状态行纯文本 + CSS 闪烁（避免 HTML 原样显示）
    addLine(box, 'div', 'stat' + (running ? ' blink' : ''), statLine);
    if (cur === null) {
      var sessLabel = state.sessionBlank ? '（新会话）' : (state.sessionTitle || '（新会话）');
      addLine(box, 'div', 'row', esc(state.workspaceTitle || '未分组') + ' / ' + esc(sessLabel));
      if (state.summary) addLine(box, 'div', 'row', esc(state.summary));
      else if (state.status === 'running') addLine(box, 'div', 'row dim', 'wait…');
      applyScroll();
      return;
    }
    // 单条完整内容，不做截断；消息过长由 ↑↓ 滚动查看
    var who = cur.msg.role === 'user' ? '▶ 我' : '◀ DSH';
    addLine(box, 'div', 'row dim', who + ' · 第 ' + (cur.index + 1) + ' 条');
    addLine(box, 'div', 'row', esc(cur.msg.text));
    addLine(box, 'div', 'navline', '←→ 上/下条 · ↑↓ 滚动查看全文');
    applyScroll();
  }

  function addLine(box, tag, cls, text) {
    var el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    box.appendChild(el);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderPad() {
    var phase = $('phase');
    if (state.pendingQuestion) {
      phase.textContent = state.questionSupported === false
        ? '题目限电脑端作答'
        : '↑↓ 选项 · ←→ 题目 · A 提交整组';
    } else {
      phase.textContent = '←→ 消息 · ↑↓ 滚动 · A 发送';
    }
    $('btnYes').className = 'bbtn yes' + (state.pendingApproval ? ' pulse' : '');
    $('btnNo').className = 'bbtn no' + (state.pendingApproval ? ' pulse' : '');
  }

  /* ---------- 交互 ---------- */
  function ensureQState() {
    var qs = state.questions || [];
    while (sel.length < qs.length) sel.push(-1);
    if (qIndex >= qs.length) qIndex = 0;
    if (qIndex < 0) qIndex = 0;
  }

  function nav(dir) {
    if (state.pendingQuestion) {
      if (state.questionSupported === false) return;
      var qs = state.questions || [];
      if (qs.length === 0) return;
      ensureQState();
      var q = qs[qIndex];
      var opts = q.options || [];
      if (dir === 'up' || dir === 'down') {
        if (opts.length === 0) return;
        sel[qIndex] = (sel[qIndex] + (dir === 'up' ? -1 : 1) + opts.length) % opts.length;
        renderLcd();
        return;
      }
      if (dir === 'left' || dir === 'right') {
        var step = dir === 'left' ? -1 : 1;
        var next = qIndex + step;
        if (next < 0 || next >= qs.length) { beep(); return; }
        qIndex = next;
        renderLcd();
      }
      return;
    }
    // 普通模式：←→ 单条切换（锚点）；↑↓ 滚动，到底/到顶自动翻组
    var msgs = state.messages || [];
    if (dir === 'left' || dir === 'right') {
      if (msgs.length === 0) { beep(); return; }
      var i = msgIndex >= 0 && msgIndex < msgs.length ? msgIndex : msgs.length - 1;
      var nextI = dir === 'left' ? i - 1 : i + 1;
      if (nextI < 0 || nextI >= msgs.length) { beep(); return; }
      msgIndex = nextI;
      scrollOff = 0;
      applyScroll();
      renderLcd();
      return;
    }
    if (dir === 'up' || dir === 'down') {
      // ↑↓ 仅滚动当前消息全文；到边界静默停住（切换消息用 ←→）
      var delta = dir === 'up' ? -SCROLL_STEP : SCROLL_STEP;
      viewScroll(scrollOff + delta);
    }
  }

  function submitQuestions() {
    var qs = state.questions || [];
    if (qs.length === 0) { showToast('题目已失效', 'err'); return; }
    ensureQState();
    var answers = [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var picked = sel[i] >= 0 && sel[i] < (q.options || []).length ? [q.options[sel[i]]] : [];
      var c = (custom[q.id] || '').trim();
      if (picked.length === 0 && c === '') { showToast('第 ' + (i + 1) + ' 题未作答', 'err'); return; }
      var ans = { id: q.id, selected: picked };
      if (c !== '') ans.custom = c;
      answers.push(ans);
    }
    api({ action: 'question-answer', answers: answers }, '已提交整组答案');
  }

  function onSend() {
    if (state.pendingQuestion) {
      if (state.questionSupported === false) { beep(); return; }
      submitQuestions();
      return;
    }
    var text = $('input').value.trim();
    if (text === '') { beep(); return; }
    $('input').value = '';
    api({ action: 'send', text: text }, '已发送');
  }

  /* ---------- 状态解析 ---------- */
  function onMessage(event) {
    try {
      var next = JSON.parse(event.data);
      var approval = null, question = null;
      if (next.pending) {
        for (var i = 0; i < next.pending.length; i++) {
          var item = next.pending[i];
          if (item.kind === 'approval' && !approval) approval = item;
          if (item.kind === 'question' && !question) question = item;
        }
      }
      state.pendingApproval = approval !== null;
      state.pendingQuestion = question !== null;
      state.approvalTool = approval ? approval.toolName : '';
      state.approvalReason = approval ? approval.reason : '';
      state.questions = question ? (question.questions || []) : [];
      state.questionSupported = question ? question.supported !== false : true;
      var qKey = question ? question.key : '';
      if (qKey !== lastQKey) {
        lastQKey = qKey;
        qIndex = 0;
        sel = [];
        custom = {};
        $('input').value = '';
      }
      state.connected = next.connected === true;
      state.status = next.status || 'idle';
      state.summary = next.summary || '';
      state.sessionId = next.sessionId;
      state.sessionTitle = next.sessionTitle;
      state.sessionBlank = next.sessionBlank === true;
      state.workspaceId = next.workspaceId;
      state.workspaceTitle = next.workspaceTitle;
      state.workspaces = next.workspaces || [];
      state.sessions = next.sessions || [];
      state.messages = next.messages || [];
      state.bridgeOnline = next.bridgeOnline === true;
      // 消息变化时保持浏览位置：跟最新（原在末尾），否则保持相对下标
      var msgs = state.messages;
      if (msgs.length !== prevMsgCount) {
        if (prevMsgCount === 0 || msgIndex >= prevMsgCount - 1 || msgIndex < 0) msgIndex = -1; // 回到最新
        else msgIndex = Math.min(msgIndex, msgs.length - 1);
        prevMsgCount = msgs.length;
        scrollOff = 0;
      }
      render();
    } catch (e) { /* 忽略坏消息 */ }
  }

  function connect() {
    if (token === '') { showToast('URL 缺少令牌，请重新扫码', 'err'); return; }
    var es = new EventSource('/events?t=' + encodeURIComponent(token));
    es.onerror = function () { state.connected = false; render(); };
    es.onmessage = onMessage;
  }

  /* ---------- 事件绑定 ---------- */
  $('btnSend').addEventListener('click', onSend);
  $('btnPause').addEventListener('click', function () { api({ action: 'pause' }, '已请求中断', '暂停失败'); });
  $('btnYes').addEventListener('click', function () {
    if (!state.pendingApproval) { beep(); return; }
    api({ action: 'approval', outcome: 'allowed-once' }, '已允许', '审批失败');
  });
  $('btnNo').addEventListener('click', function () {
    if (!state.pendingApproval) { beep(); return; }
    api({ action: 'approval', outcome: 'rejected' }, '已拒绝', '审批失败');
  });
  $('dUp').addEventListener('click', function () { nav('up'); });
  $('dDown').addEventListener('click', function () { nav('down'); });
  $('dLeft').addEventListener('click', function () { nav('left'); });
  $('dRight').addEventListener('click', function () { nav('right'); });
  $('wsSel').addEventListener('change', function (e) {
    var v = e.target.value;
    if (!v || v === state.workspaceId) return;
    api({ action: 'switch-workspace', workspaceId: v }, '已切换工作区', '切换失败');
  });
  $('sessSel').addEventListener('change', function (e) {
    var v = e.target.value;
    if (v === '__new__') {
      try { $('sessSel').value = state.sessionId || ''; } catch { /* noop */ }
      api({ action: 'new-session' }, '已新建会话', '新建失败');
      return;
    }
    if (!v || v === state.sessionId) return;
    api({ action: 'switch-session', sessionId: v }, '已切换会话', '切换失败');
  });
  $('input').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    onSend();
  });
  if (navigator.wakeLock) {
    navigator.wakeLock.request('screen').catch(function () {});
  }
  render();
  connect();
})();
</script>
</body>
</html>
`;
