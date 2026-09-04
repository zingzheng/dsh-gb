# dsh-gb 待办与优先级（TODO）

> 与 AGENTS.md 同级的规划文档：只记录**已确认方向**与**待确认**的改进项，
> 每条给出依据、改动范围与验收方式，按优先级从高到低排列。
> 上次更新：2026-09-04（本轮新增远程调研记录，详见文末）。

## 当前状态

调研了同类插件 `@linxin666/dsh-remote-web-ui`
（github.com/zhu1090093659/dsh-web · packages/dsh-remote-web-ui，dev 分支，v0.3.14）：

**产品定位完全不同，不是竞品而是互补。** 我们是「外设遥控 + 小状态屏」——
独立 Game Boy UI、只搬高频动作、零耦合官方 DOM；它是「官方 GUI 远程复刻」——
完整 DSH + 竖屏适配层 + 配对设备体系 + 隧道/防火墙/自更新。
它们解决「人离开电脑也能用 DSH」，我们解决「人在电脑前，手机当外设」。
调研结论与采纳/不采纳清单见文末，本文件的条目已吸收其可借鉴部分。

**2026-09-04 本轮完成**：
- P0-3 内置公网隧道（路线 A：cloudflared 快速/命名隧道，运行时下载、设置页开关）
  —— 已实现，待用户真机验证 + 提交；
- P1-1 控制端点仅回环 + `/info` 非回环脱敏 —— 已实现；
- P0-2 断桥提示、P2 可靠性三小项 —— 未动，顺序照旧；
- P0-1 同源完整代理 —— 公网隧道已让「手机侧远程」可用，其优先级降为「暂缓」
  （仅当希望不暴露 7788、且 GUI 已隧道化时才需要），方向保留。

## P0 · 功能缺口（做完 = 核心体验闭环）

### P0-3 内置公网隧道（路线 A）✅ 已实现（2026-09-04，待真机验证 + 提交）
- 内容：`lib/tunnel.js` TunnelManager + `lib/index.js` 接线 + 设置页「⑤ 公网隧道」
  控制区（开关/快速/命名/token/域名/状态）+ `~/.dsh/dsh-gb.json` 配置持久化。
- 快速隧道：cloudflared `--url`（临时 trycloudflare 地址，重启变化）；
  命名隧道：`tunnel run --token`（固定域名）。
- cloudflared 运行时下载（流式写盘、300s 超时、2 次重试、`DSH_GB_CLOUDFLARED_URL`
  换源），缓存 `$DSH_HOME/cache/dsh-gb/`；**无 postinstall/prepare**（AGENTS §2-12）。
- 验证：`node test/tunnel.mjs`（桩，不联网）+ `node test/serve.mjs`（公网 URL
  覆盖/隧道状态透传/非回环 /info 403）+ `node test/tunnel-live.mjs`（手动真机）。
- 待用户：重启 dsh 后在设置页开启快速隧道，手机 4G/异地 WiFi 扫码验证；
  命名隧道需自带域名 + CF 控制台一次配置。

### P0-1 手机侧远程：同源完整代理（暂缓，方向保留）
- 状态：**暂缓**（公网隧道 P0-3 已覆盖手机侧远程；同源代理仅在「不想暴露 7788
  且 GUI 已隧道化」时有意义）
- 背景：浏览器侧已走 webServer 同源 `/phone-remote/*` 代理（隧道/VNC 场景证实
  可用），但手机只能直连 `7788`。
- 方案（保留）：把代理从 bridge 三件套扩成完整同源页面：`/phone-remote/phone`
  （HTML）、`/phone-remote/api`（POST）、`/phone-remote/events`（SSE）；
  `phone-page.js` 支持 `?b=<前缀>`；设置页 sameOrigin 且非本机时 QR 给
  `location.origin` 前缀地址。
- ✅ QR 容量：2026-09-04 已升级内置 qr.js 到版本 1-6（v6-L 上限 134 字节），
  覆盖 trycloudflare 公网地址（实测 87 字节，v5-L 即可）；v7+ 需版本信息 BCH
  绘制，如未来 URL 再超长再议；check-qr.mjs 已补 87/97 字节与 H/Q 级用例。

### P0-2 手机页显示「桥接断开」
- 状态：**待开工**（小改动，10 分钟级）
- 现状：`mergedState()` 已带 `bridgeOnline`（server-core.js:210），手机页也收到了
  （phone-page.js:457），但 `renderLcd()` **没有展示**。GUI 桥一断（关了标签页 /
  客户端崩溃 / 重启 dsh），手机仍显示旧状态，看似正常，实际 send/approval 点了
  才报 no-bridge——状态屏最伤信任的场景。
- 方案：状态行加 `⚠ 桥接断开`（blink/dim）；`phase` 文案同步提示；
  `test/serve.mjs` 补断言。
- 生效：host 半部（phone-page.js），重启 dsh。

## P1 · 安全加固（调研新增，优先于体验项）

### P1-1 控制端点仅回环（学 remote-web-ui 原则）✅ 已实现（2026-09-04）
- 实现：`/phone-remote/tunnel`（GET/POST）与 `/phone-remote/token/reset` 对
  非回环来源 403 `loopback-only`；`/phone-remote/info` 对非回环来源
  `url:null` + `restricted:true`（不携带令牌/URL）；回环判定 = socket 地址
  （`isLoopback`，server-core 导出复用，socket+Host 双检查留待后续若有 Host 头
  攻击面再补）。
- 设置页：restricted 时只读横幅（二维码/重置/隧道控件隐藏）。
- 验收：`node test/serve.mjs` 已含非回环 `/info` 403 用例（真 LAN IPv4 验证）。
- 残留：`bridgeProxy` 三件套保持原样（远程访问本体，经上游令牌鉴权，响应不含令牌）。

## P2 · 手机侧可靠性（小改动、高感知）

- [ ] P2-1 键盘/矮屏适配：`body{height:100%}` + `justify-content:center`
  （phone-page.js:18-21）在矮屏（~667px）或 Android 键盘弹起时上下裁切、输入框
  可能被盖。改 `min-height:100svh` + 安全居中 + viewport
  `interactive-widget=resizes-content`；真机验证。
- [ ] P2-2 wakeLock 跟随可见性：现在仅加载时 request 一次（phone-page.js:510），
  切后台/锁屏即失效——「小状态屏」定位的核心。加 `visibilitychange` 重拿；
  iOS 不支持则 README 注明（与 remote-web-ui 的适配层取舍一致：只维护自家可行的）。
- [ ] P2-3 待审批震动：`pendingApproval` false→true 时 `navigator.vibrate`
  （Android Chrome；iOS 无此 API）。仅震动不做音频（Web Audio 需用户手势初始化）。

## P3 · 工程化/发布

- [ ] P3-1 GitHub Actions CI：三测试（check-qr / serve / client-bundle）
  + **临时重建 client.js 与提交版 diff**（防零构建承诺被破坏）
  + BOM/LF 检查（AGENTS §2-1 历史事故类）。
- [ ] P3-2 代理层可测试化：把 `index.js` 的 `bridgeProxy` / `registerAll` 抽到
  `lib/proxy-routes.js`（纯函数：给定 server + token + register 表），
  serve.mjs 用假 webServer 测——rc.7 激活时序翻车的区域至今零覆盖
  （学 remote-web-ui 的 wire 契约测试思路）。
- [ ] P3-3 发布 tag + 钉版本：`v0.1.0` tag；README 补
  `github:zingzheng/dsh-gb#v0.1.0` 钉版本写法；考虑在 package.json 声明
  `dsh.engines.dsh`（remote-web-ui 已有此字段，README 徽章落地为机器可读）。
- [ ] P3-4 设置页诊断折叠区：展示 /info 已算出但未展示的 `lastActionError` /
  `bridgeStateCount` / `stateReceived`（server-core.js:264-268），
  排查「手机看不到最新状态」一查一个准。

## 明确不做（保持差异化的决定，持续有效）

- 斜杠命令 / 消息 markdown 渲染：违反红线（低频 / 重复电脑端能力），维持
  AGENTS §0 推迟。
- 遥测：remote-web-ui 有每日匿名心跳；**我们零遥测是卖点**，不学。
- 隧道 / 防火墙 / 自更新等平台级能力（cloudflared 二进制、netsh/firewalld 管理、
  一键升级 dsh-web）：属于「手机版 DSH」的重量级配套，与「外设」定位冲突，全不学。
- 配对设备体系（一次性 QR + 设备会话 + 逐设备撤销）：单用户单令牌模型够用；
  将来若有真实多机需求再议。

---

## 调研记录：@linxin666/dsh-remote-web-ui

来源：github.com/zhu1090093659/dsh-web · packages/dsh-remote-web-ui（dev 分支，
v0.3.14，Apache-2.0）。调研日期：2026-09-04。结论仅供存档参考。

### 产品差异（关键）

| 维度 | 我们 dsh-gb | 它们 remote-web-ui |
|---|---|---|
| 本质 | 外设遥控 + 小状态屏（手机**不是** DSH） | 官方 GUI 的远程复刻（手机 = 完整 DSH） |
| 界面 | 独立 Game Boy 单页，零耦合官方 DOM | 官方 GUI 本身 + 竖屏适配层（语义后缀选择器；官方改名需视觉 QA） |
| 能力 | 高频 5 类动作 + 状态一瞥 | 100% 桌面能力（含设置/凭据/预设/产出物） |
| 连接 | 同局域网直连 7788；浏览器侧走同源代理 | LAN 绑定开关 + Cloudflare 快速/命名隧道 + 固定域名中继（dsh-market） |
| 信任模型 | 轻：手机=外设，token 鉴权，动作有限 | 重：**配对设备 = 完全控制凭据**（作者 README 明说） |
| 安装 | git 零构建、零运行时依赖 | npm 包 + tsdown build + prepare 脚本（pnpm≥10 需 allowBuilds）+ cloudflared postinstall 下载 |
| 配置 | 无（内置默认） | schemastery schema（tokenTtlMs / maxDevices / publicBaseUrl / tunnelToken / relay / lanBind…） |
| 测试 | 纯 node 冒烟 | vitest + testing-library 组件 + wire 契约 + 手动 E2E 脚本 |

### 我们采纳的（已吸收进上方条目）

1. 控制端点仅限回环（routes/update 栅栏 + 远程横幅）→ P1-1。
2. 回环判定 = socket + Host 双检查（gate.ts `isLoopbackClient`）→ P1-1。
3. wire 契约测试（路由族与连接闭环均有用例与手动 E2E 脚本）→ P3-2。
4. 长 URL 的 QR 容量：它们用 qrcode.react（自动选版本/SVG 内联）；我们内置
   编码器最初只到 v4 → 2026-09-04 已升到 v1-6（134 字节），已处理。
5. 声明 `dsh.engines.dsh`（把 README 徽章变为机器可读约束）→ P3-3。
6. 若将来做远程配置（phoneUrl），用标准 `settings.installSection` + schemastery，
   不自己发明配置通道（照搬其 Config schema + live re-read 模式）。

### 不采纳（理由）

- 隧道 / 中继 / 隧道令牌：基础设施级；作者用自带域名做「书签永久有效」，
  我们保持「隧道由用户自己出 + 同源代理自动跟随」的轻量路径（P0-1）。
- 设备会话 / 撤销 / 离线检测：单用户场景 token 持久化 + 重置全废已覆盖。
- 自更新 / 防火墙 / 遥测 / 英文 i18n：超范围或违背定位（遥测明说不学）。
- TypeScript / tsdown / vitest 全家桶：零构建 + 纯 node 冒烟是刻意的差异化；
  等 P0-1 引入更多路由、规模上台阶后再评估。
