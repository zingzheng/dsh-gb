# dsh-gb · 掌机

<div align="center">
  <b>把手机变成 DSH 的「Game Boy」遥控台</b><br />
  同一局域网内扫码即连：语音输入 · 审批 yes/no · 选择题 · 摇杆浏览 + 实时状态小屏
  <br /><br />
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/zingzheng/dsh-gb/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/zingzheng/dsh-gb" /></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="适配 DSH（0.1.0-rc.7 与 0.1.1-rc.2 实测）：0.1.0-rc.7+" src="https://img.shields.io/badge/DSH-0.1.0--rc.7%2B-4d6bfe" /></a>
  <br /><br />
  <img alt="局域网" src="https://img.shields.io/badge/-局域网-4d6bfe" />
  <img alt="手机遥控" src="https://img.shields.io/badge/-手机遥控-4d6bfe" />
  <img alt="Game Boy" src="https://img.shields.io/badge/-Game%20Boy-9bbc0f" />
  <img alt="零运行时依赖" src="https://img.shields.io/badge/-零运行时依赖-4d6bfe" />
</div>

DSH 网页版「掌机」插件：手机和电脑连同一个 Wi-Fi，用手机扫一个二维码，手机就变成
DSH 的**外设遥控器 + 小状态屏**——你坐在电脑前，手机随手一瞥就是 agent 的运行状态，
消息、审批、选择题都能在手机上直接处理。

## ✨ 功能一览

- **📡 实时状态栏**：当前工作区 / 会话 / agent 状态（`● 运行中` / `○ 空闲` / 待审批 /
  选择题）+ 一行总结 + 消息浏览进度（`‹ 第 N/M 条 ›`）。
- **🎤 语音输入**：直接调用手机输入法的语音转文字，A 键 / 回车发送进当前会话。
- **✅ 审批**：`YES` = 允许一次、`NO` = 拒绝，与 GUI 审批面板语义一致；有待审批时
  键位高亮闪烁提醒。
- **🔢 选择题**：`↑↓` 选选项、`←→` 翻题，A 键发送 = 提交整组答案。
- **🎮 摇杆与按键**：正常模式下 `←→` 上一条 / 下一条消息、`↑↓` 滚动查看完整消息；
  `B` 暂停（中断运行中的 agent，等价 GUI 停止）。
- **🔀 会话管理**：顶部下拉切换工作区 / 会话，`＋ 新建会话` 一键开新会话。
- **🖥️ GUI 设置页「掌机」**：动态二维码、连接 URL、在线手机数 / 桥接状态 / 消息数实时统计。
- **🔋 零运行时依赖**：二维码编码器为内置实现（无任何 npm 运行时依赖）；令牌鉴权 +
  收紧 CORS；`/info` 仅限本机回环。

## 🚀 安装

**前置**：`dsh web` 能正常运行，Node.js ≥ 20、pnpm ≥ 10、git。

**支持的 DSH 版本**：<img alt="0.1.0-rc.7 与 0.1.1-rc.2 实测" src="https://img.shields.io/badge/DSH-0.1.0--rc.7%2B-4d6bfe" />

### 方式一：一条命令

```sh
dsh plugin --profile web add github:zingzheng/dsh-gb
```

> 包名写完整 git 地址也可以：`dsh plugin --profile web add https://github.com/zingzheng/dsh-gb.git`

这条命令会在 profile 里安装依赖，并自动把声明了 `dsh.bundle` 的本插件加入挂载层
（无需手动改 `cordis.patch.yml`）。装完 **重启 dsh**（插件带 host 半部，只在启动时
挂载），然后在 GUI 设置 →「掌机」扫码连接。

如果提示「找不到 profile 目录」，先跑一次 `dsh web` 初始化 `~/.dsh/profiles/web` 即可。

### 方式二：把这段话贴给 DSH（懒得敲命令）

把下面这段提示词发给任意一个 DSH 会话，让它自己装：

```text
帮我安装 dsh-gb 插件（DSH 掌机：手机扫码变成 DSH 的 Game Boy 遥控台 + 小状态屏），步骤：
1. 执行 dsh plugin --profile web add github:zingzheng/dsh-gb
2. 完成后提醒我重启 dsh（host 半部只在启动时挂载），再硬刷新浏览器（Ctrl/Cmd+Shift+R）
3. 遇到报错先查 https://github.com/zingzheng/dsh-gb 的 README「常见问题」。
```

### 方式三：从源码安装 / 开发（可选）

```sh
git clone https://github.com/zingzheng/dsh-gb.git
cd dsh-gb
pnpm install                 # 只装测试依赖（qrcode / jsqr）
node scripts/build-client.mjs
```

开发挂载二选一（与「方式一」的自动挂载**互斥**，勿同时使用，否则会重复挂载报错）：

1. 把 `~/.dsh/profiles/web/package.json` 依赖指向本地克隆：
   `"dsh-gb": "link:D:/path/to/dsh-gb"`（开发迭代推荐 Windows junction 连到该目录）；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加与插件 `cordis.patch.yml` 相同的行：
   ```yaml
   - insert:
       - id: dsh-gb
         name: 'dsh-gb'
   ```

然后 `pnpm install`、重启 dsh、硬刷新浏览器。`lib/client.js` 已提交仓库（git 安装
零构建、无构建脚本审批），改动 host 半部需重启 dsh，client 半部硬刷新即可。

<details>
<summary><b>更新</b></summary>

重跑同一条安装命令（git 依赖会重新解析最新提交），然后重启 dsh：

```sh
dsh plugin --profile web add github:zingzheng/dsh-gb
```

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `duplicate loader entry id` / 页面出现两个「掌机」 | 自动挂载与手动行重复：删除 `~/.dsh/profiles/web/cordis.patch.yml` 里 dsh-gb 的 `insert` 行。 |
| 设置页报「未检测到本地掌机服务」 | 多因版本激活时机导致同源路由未注册：重跑一次安装命令（git 依赖会拉到最新提交）、重启 dsh、硬刷新浏览器。若是在**另一台设备**上访问 GUI（隧道/远程），请确认用的是新版本（含同源 /phone-remote/* 代理与 hostname 扫描）。 |
| 报 `dsh: command not found` | 先安装 DSH；或 `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add github:zingzheng/dsh-gb`。 |
| 找不到 profile 目录 | 先跑一次 `dsh web` 初始化 `~/.dsh/profiles/web`。 |
| 手机上打不开页面 / 二维码转圈 | 手机与电脑须在同一局域网；放行 dsh（Node.js）通过 Windows 防火墙（专用网络）；检查路由器是否开了 AP 隔离。 |
| 端口被占用 | 服务器会在 `7788–7795` 自动顺延（二维码显示实际端口）。 |
| 提示构建脚本被拦截 | 本插件无 prepare 脚本，一般不会出现；如其他插件环境报此错，在 profile 目录允许对应包即可。 |
| 改了插件代码不生效 | host 半部（`lib/index.js`、`server-core.js`、`phone-page.js`）需重启 dsh；client 半部（`client-src.js`）硬刷新浏览器。 |

</details>

## 📱 使用注意

- 手机与电脑需同一局域网；局域网其他设备即使拿到 URL 也**无法**使用（页面与 API
  均要求随机令牌；令牌**首次启动生成并持久化**于 `~/.dsh/dsh-gb.token`，重启 dsh
  不变，二维码与 URL 可收藏长期使用；设置页「重置令牌」可一键作废旧令牌）。
- 设备间通信端口默认 `7788`，被占用时自动顺延至 `7795`。
- 审批语义为「允许一次」（与 GUI 审批面板一致）。

## 📌 远程访问（已知限制）

当前设计的前提：**手机与运行 dsh 的主机在同一局域网**——手机经二维码直达主机
`7788` 端口的局域网服务器（`/info`、bridge、全部动作都走该服务器直连）。

- ✅ **浏览器侧已支持远程**：GUI 经隧道/代理访问时，bridge 与设置页走 dsh
  webServer 的**同源代理**（`/phone-remote/*`）——只需把 GUI 端口转发到本地，
  全部状态与操作即可工作（VNC / SSH 隧道场景证实可用）。
- ⚠️ **手机侧仍是直连**：手机必须先能到达 dsh 主机的局域网地址（同一 Wi-Fi，
  或自行用隧道/VPN 打通 `7788`）。手机与主机不同网络时二维码不可用。
- 🧭 **计划中（后续迭代重点）**：二维码/连接地址可配置（如 `phoneUrl`，指向
  隧道/VPN 可达的外网地址）；手机端手动输入服务器地址兜底；Token 粘贴连接。

## 🔐 安全

- 全部接口（页面 / SSE / 动作 API）要求随机令牌（首次启动生成后持久化于
  `~/.dsh/dsh-gb.token`，128 位随机，可经设置页「重置令牌」作废）；`/info`
  仅限本机回环访问；动作接口收紧 CORS，仅放行同源应用。
- 服务器只监听局域网 `0.0.0.0:7788+`，不暴露公网、无外联行为。

## 🧩 架构一览

插件为 host / client 双半部，构建后零运行时依赖：

```
手机 ──SSE(状态)/POST(动作)──> 局域网HTTP服务器(0.0.0.0:7788+) <──POST/bridge/state── GUI客户端中继
                                    │  ^
                                    └──SSE(bridge/events: 命令)──┘
```

- **Host 半部**（`lib/index.js` + `lib/server-core.js`）：局域网 HTTP 服务器（手机页 /
  SSE / 动作 API / 令牌鉴权 / CORS），监听 `agent/status` 与会话事件维护运行态与
  一句话总结；`send` 动作直接 `followup` 注入当前会话；另在 dsh 自带 webServer
  注册同源 `/phone-remote/info`（设置页二维码数据源）。
- **Client 半部**（`lib/client.js`，由 `lib/client-src.js` + `lib/qr.js` 构建）：
  - `conversation.composer.dock` 会话槽挂不可见中继：推送审批 / 选择题 / 会话与工作区
    列表到服务器，并执行打开会话 / 连接工作区 / 应答（复用 GUI 同款
    `PendingWait.respond`）。
  - `settings.section` 设置页「掌机」：内置 QR 编码器（零依赖）生成动态二维码。

## 🛠️ 开发与测试

```sh
pnpm install                    # 测试依赖：qrcode / jsqr
node scripts/build-client.mjs   # 改 lib/client-src.js / lib/qr.js 后重新打包 client
node test/check-qr.mjs          # QR 编码器 vs node-qrcode / jsQR 交叉校验
node test/serve.mjs             # 服务器核心端到端冒烟（页面 / SSE / API / 令牌 / 导航）
node test/client-bundle.mjs     # client bundle 假装载校验
```

提交前建议跑 `node test/check-qr.mjs && node test/serve.mjs && node test/client-bundle.mjs`
三者全绿，并确保 `lib/client.js` 已重新构建后一起提交。

## 📄 License

[MIT](./LICENSE)
