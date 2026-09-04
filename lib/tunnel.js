// dsh-gb — 公网隧道管理（纯 Node，无 cordis 依赖）。
// 负责 cloudflared 二进制的「运行时下载 + 生命周期」：快速隧道（零账号/零域名，
// trycloudflare.com 临时地址）与命名隧道（自带域名 + CF 控制台 token，地址固定）。
// 约束（AGENTS §2-12）：二进制只经本模块运行时下载，禁止入库 / 禁止 postinstall；
// 对外只暴露状态机（off/starting/running/failed）与 url，供 index.js 接入 QR。
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const CLOUDFLARED_ARTIFACT = {
  win32: 'cloudflared-windows-amd64.exe',
  linux: 'cloudflared-linux-amd64',
  darwin: 'cloudflared-darwin-amd64',
};
const CLOUDFLARED_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const DEFAULT_RESTART_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];
const DOWNLOAD_TIMEOUT_MS = 600_000; // 慢网下 55MB 可达数分钟，留足余量
const MAX_BUFFER = 4096;

export class TunnelManager {
  /**
   * @param {object} options
   * @param {(level: string, message: string) => void} [options.log]
   * @param {string} [options.cacheDir] cloudflared 缓存目录（首次启用时下载）。
   * @param {string} [options.binOverride] 测试桩路径（.mjs 由 node 解释执行）。
   * @param {number[]} [options.restartDelaysMs] 重启退避（测试可缩短）。
   * @param {object} [options.envExtra] 附加到子进程的环境变量（测试用）。
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.cacheDir = options.cacheDir ?? null;
    this.envExtra = options.envExtra ?? {};
    const artifact = CLOUDFLARED_ARTIFACT[process.platform];
    if (options.binOverride) this.binPath = options.binOverride;
    else if (artifact !== undefined && this.cacheDir !== null) this.binPath = path.join(this.cacheDir, artifact);
    else this.binPath = null; // 平台无 artifact 或未给缓存目录 → 不支持
    this.target = null;         // { mode, token, publicHost, port }
    this.child = null;
    this.phase = 'off';
    this.mode = null;
    this.url = null;
    this.error = null;
    this.retry = 0;
    this.timer = null;
    this.stopped = true;
    this.listeners = [];
  }

  status() {
    return { state: this.phase, mode: this.mode, url: this.url, error: this.error };
  }

  /** 订阅状态；订阅时立即回调当前状态（避免窗口期丢失）。 */
  onPhase(cb) {
    this.listeners.push(cb);
    try { cb(this.status()); } catch { /* 忽略订阅回调异常 */ }
  }

  emit() {
    const snapshot = this.status();
    for (const cb of [...this.listeners]) {
      try { cb(snapshot); } catch { /* 忽略 */ }
    }
  }

  /**
   * 启动/重启隧道。target = { mode: 'quick'|'named', token, publicHost, port }。
   * quick：需要 port（指向本地掌机服务器）；named：需要 token + publicHost（固定域名）。
   */
  async start(target) {
    this.stopped = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.target = {
      mode: target.mode === 'named' ? 'named' : 'quick',
      token: typeof target.token === 'string' ? target.token : '',
      publicHost: typeof target.publicHost === 'string' ? target.publicHost : '',
      port: Number(target.port),
    };
    this.retry = 0;
    this._stopChild();
    this.phase = 'starting';
    this.mode = this.target.mode;
    this.error = null;
    this.url = null;
    this.emit();
    if (this.binPath === null) {
      this.phase = 'failed';
      this.error = '当前平台无内置 cloudflared 支持';
      this.emit();
      return;
    }
    if (!(await this._ensureBinary())) return;
    this._spawn();
  }

  /** 停止隧道（不重启；保留下载好的二进制）。 */
  stop() {
    this.stopped = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this._stopChild();
    this.target = null;
    this.phase = 'off';
    this.mode = null;
    this.url = null;
    this.error = null;
    this.retry = 0;
    this.emit();
  }

  dispose() {
    this.stop();
  }

  _stopChild() {
    const c = this.child;
    this.child = null;
    if (c !== null) {
      try { c.kill(); } catch { /* 已退出 */ }
    }
  }

  /**
   * 首次启用时运行时下载（缓存命中直接复用）；成功后返回 true，
   * 失败置为 failed 并返回 false。流式写盘 + 300s 超时 + 最多 2 次尝试；
   * 可用 DSH_GB_CLOUDFLARED_URL 覆盖下载源（受限网络可换镜像）。
   */
  async _ensureBinary() {
    if (existsSync(this.binPath)) return true;
    const base = process.env.DSH_GB_CLOUDFLARED_URL ?? CLOUDFLARED_BASE;
    const url = base + path.basename(this.binPath);
    this.log('info', '首次启用公网隧道：下载 cloudflared（约 30-60MB，仅一次；网络慢时可达数分钟）…');
    mkdirSync(this.cacheDir, { recursive: true });
    const tmp = `${this.binPath}.tmp`;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const stream = createWriteStream(tmp);
        let bytes = 0;
        let lastLog = Date.now();
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
          if (Date.now() - lastLog > 8000) {
            lastLog = Date.now();
            this.log('info', `cloudflared 下载中… ${(bytes / 1048576).toFixed(1)}MB`);
          }
        }
        await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
        renameSync(tmp, this.binPath);
        this.log('info', `cloudflared 下载完成（${(bytes / 1048576).toFixed(1)}MB）`);
        return true;
      } catch (error) {
        lastError = error;
        try { unlinkSync(tmp); } catch { /* 可能不存在 */ }
        this.log('info', `cloudflared 下载失败(第 ${attempt + 1} 次): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.phase = 'failed';
    this.error = `cloudflared 下载失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    this.emit();
    return false;
  }

  _spawn() {
    const target = this.target;
    if (target === null) return;
    this.phase = 'starting';
    this.mode = target.mode;
    this.error = null;
    this.url = target.mode === 'named' && target.publicHost !== '' ? target.publicHost : null;
    if (target.mode === 'named' && target.publicHost !== '') this.phase = 'running';
    this.emit();

    const args = target.mode === 'named'
      ? ['tunnel', 'run', '--no-autoupdate', '--token', target.token]
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${target.port}`];
    // 测试桩（.mjs）由 node 解释执行；生产为 cloudflared 原生命令
    const prefix = this.binPath.endsWith('.mjs') ? [this.binPath] : [];
    const command = prefix.length > 0 ? process.execPath : this.binPath;

    let child;
    try {
      child = spawn(command, [...prefix, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.envExtra },
      });
    } catch (error) {
      this.phase = 'failed';
      this.error = `启动失败: ${error instanceof Error ? error.message : String(error)}`;
      this.emit();
      return;
    }
    this.child = child;

    let buffer = '';
    const onData = (chunk) => {
      // 进程退出后其残留输出可能晚到（exit/data 在 Windows 上可乱序）：
      // 只接受「当前存活子进程」的输出，否则会复活已 failed 的状态
      if (this.child !== child) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      // 快速隧道：解析 cloudflared 日志里的临时公网地址
      if (target.mode === 'quick' && this.phase !== 'running') {
        const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m !== null) {
          this.url = m[0];
          this.phase = 'running';
          this.retry = 0;
          this.emit();
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      this.child = null;
      if (this.stopped) return;
      this.phase = 'failed';
      this.error = `进程错误: ${error instanceof Error ? error.message : String(error)}`;
      this.url = null;
      this.emit();
      this._scheduleRestart();
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) return;
      this.phase = 'failed';
      this.error = `cloudflared 意外退出(${code !== null ? `code=${code}` : `signal=${signal ?? '?'}`})`;
      this.url = null;
      this.emit();
      this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (this.stopped) return;
    if (this.retry >= this.restartDelaysMs.length) {
      this.error = '重试次数用尽，已停止重试（检查网络/Cloudflare 后重新开启）';
      this.emit();
      return;
    }
    const delay = this.restartDelaysMs[this.retry++];
    this.log('info', `cloudflared 已退出，${delay}ms 后第 ${this.retry} 次重启`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this._spawn();
    }, delay);
  }
}
