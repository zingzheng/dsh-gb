# dsh-gb 仓库规则（AGENTS）

> 本文面向本仓库的贡献者与 agent，只含**项目全局开发规则**。
> 安装方式、功能说明、常见问题 → [README.md](README.md)。

## 0. 项目定位红线（最重要）

**dsh-gb 是「外设遥控 + 小状态屏」，不是「手机版 DSH」。**

- 手机是电脑前的外设：单手可完成、高频的动作（发送消息、yes/no 审批、选择
  题、状态一瞥、切会话/工作区）才值得搬上手机。
- 拒绝把电脑端完整能力往掌机塞——那会让它沦为"手机上的 DSH"，丧失定位。
- 取舍标准：**高频？能否单手完成？是否只是重复电脑端已有能力？** 三者不满足
  就不做，或明确记录为"被推迟"再讨论。

### 已记录的被推迟决策（讨论后挂起，勿直接实现）

- 斜杠命令支持（命令菜单 / chips / 输入联想）——低频，后期看情况再议。
- 远程访问完整方案（`phoneUrl` 可配置、手机端手动输地址、Token 粘贴连接）——
  当前约束已写入 README「远程访问（已知限制）」，后续迭代。

## 1. 目录结构与产物边界

| 路径 | 职责 | 属性 |
|---|---|---|
| `lib/index.js` | Host 半部入口：LAN 服务器接线、事件监听、同源 `/phone-remote/*` 代理 | **手写**，改动需重启 dsh |
| `lib/server-core.js` | `PhoneRemoteServer`：LAN HTTP 服务器（页面/SSE/动作 API/令牌/CORS） | **手写**，改动需重启 dsh |
| `lib/phone-page.js` | 手机页 HTML（Game Boy 风格，单文件） | **手写**，改动需重启 dsh |
| `lib/client-src.js` | Client 半部源码（设置页 + RootBridge + SessionRelay） | **手写**，改动后必须重打 bundle |
| `lib/qr.js` | 内置 QR 编码器（零依赖，版本 1-4） | **手写**，改动后必须重打 bundle |
| `lib/client.js` | **构建产物**（qr.js + client-src.js 拼接成 `__ModuleLoader__.load`） | **禁止手改**；由 `node scripts/build-client.mjs` 生成并**必须提交** |
| `scripts/build-client.mjs` | client bundle 构建 | 保持零依赖（纯 node） |
| `test/*.mjs` | 冒烟测试（check-qr / client-bundle / serve / preview） | serve.mjs 与 preview.mjs 直接实例化 `PhoneRemoteServer`，**不依赖 cordis** |
| `cordis.patch.yml` | 插件自带 bundle patch（与 `dsh plugin add` 自动挂载通道一致） | 勿轻易改动 |

`node_modules/`、`*.tgz` 由 `.gitignore` 排除；`lib/client.js` **不在**忽略列表，
没有它 git 安装就失去"零构建"特性。

## 2. 硬性约束（违反 = 直接返工）

1. **编码与行尾**：所有文件 UTF-8 **无 BOM**、行尾 LF（`.gitattributes` 已固定）。
   批量写文件务必用显式无 BOM 编码（Node fs / `UTF8Encoding($false)`）——历史事故：
   BOM 曾导致 dsh 启动时 `package.json` 解析失败。
2. **`lib/client.js` 是生成物**：改 `client-src.js` / `qr.js` 后必须重打
   `node scripts/build-client.mjs` 并提交两者；禁止绕过构建直接改它。
3. **内嵌 JS 形态**：`phone-page.js` 与 `client-src.js` 会被拼进宿主模板字面量/
   bundle 工厂——**无 TS/JSX/import/require（client 仅 `require('react')`）**；
   页面 JS 避免 `\`${...}\`` 模板串与 `${` 序列；client 组件用
   `React.createElement`，不要写 `<Component />`。
4. **包保持"零运行时依赖 + 无构建脚本"**：`dependencies` 必须为空（QR 编码器是
   内置的）；**不要加 `prepare`/`install`/`postinstall`**——那会把 git 安装从
   "零审批直接装"变成"被 pnpm 构建脚本拦截"。测试依赖只能进 `devDependencies`
   （qrcode / jsqr）。
5. **服务一律可选获取**：`ctx.get(...)` 判空后再用（webServer / agents /
   sessionQuery / logger），不得假定某个 DSH 版本必须有；引用新服务前先验证
   支持版本（当前基线 `0.1.0-rc.7+`，实测 rc.7 与 0.1.1-rc.2）。
6. **同源路由必须先等 `webServer`**：注册 `/phone-remote/*` 前轮询
   `ctx.get('webServer')`（每 500ms 重试）——直接注册会因激活时序竞态静默失败
   （rc.7 上踩过整个桥接失效的坑）。
7. **客户端连接地址禁止写死 `http://127.0.0.1:<port>`**：一律走 `endpointOf()`
   （同源 `/phone-remote/*` 优先，否则用扫描发现的 host）。
8. **`lanIp()` 必须过滤 docker 默认网段**（172.17-172.22），否则扫码地址可能指向
   docker0 导致手机连不上。
9. **安全**：页面 / SSE / API 全部要求随机令牌；令牌**首次启动生成后持久化**于
   `~/.dsh/dsh-gb.token`（机器级，**绝不能放进仓库/提交**），重启复用、设置页可
   重置（重置会断开全部旧连接）；`/info` 仅限回环（或仅经同源路由）访问；
   **禁止新增无鉴权的 LAN 接口**。
10. **挂载单通道**：`dsh.profile.bundles`（bundle 层）与 profile `cordis.patch.yml`
    手动行**二选一**——同时存在会 `duplicate loader entry id` 启动崩溃。
11. **数据读取**：会话消息用 `sessionQuery.readSurface()`（`listEvents` 只含元数据，
    没有内容）；标题用 `readTitleSnapshots()`；消息上限 40 条、单条 1200 字符。

## 3. 改动后验证（提交前必须全绿）

```sh
node scripts/build-client.mjs   # 若动过 client 侧
node test/check-qr.mjs          # QR 编码器 vs node-qrcode / jsQR 交叉校验
node test/client-bundle.mjs     # client bundle 假装载 + 注册断言
node test/serve.mjs             # 服务器端到端冒烟（页面/SSE/API/令牌/导航）
```

- host 半部（index/server-core/phone-page）改动：`node test/serve.mjs` 必须过，
  并提醒用户**重启 dsh** 才生效；
- client 半部改动：重打 bundle 且 `test/client-bundle.mjs` 过，提醒用户**硬刷新**；
- 想肉眼验证手机页：`node test/preview.mjs`，打开它打印的带令牌 URL。

## 4. 开发环境约定

- profile：`~/.dsh/profiles/web`（Windows 路径同）；插件以 `file:` 依赖 +
  `node_modules/dsh-gb` **junction 指向** `本仓库目录`（开发迭代即改即生效）。
  注意：profile 里跑 `pnpm install` 会把 junction 换成拷贝（代码改动不生效），
  跑完需要重建 junction——README「开发与测试」有说明。
- 生效规则：host 半部改动 = 重启 dsh；client 半部改动 = 重打 bundle + 硬刷新
  浏览器（client.js 带版本号缓存）。
- `dsh plugin ...` 命令会触发 profile 的 bundles reconcile（写
  `dsh.profile.bundles`）——它是**有副作用的写命令**，不是只读探查；不建议用它
  来做"查语法/查支持格式"，要看实现请直接读 `dsh` 包源码。

## 5. 命名与文案

- 插件 id / 包名：`dsh-gb`；中文名：**掌机**；日志前缀：`[dsh-gb]`。
- 用户可见文案统一「掌机」；页面标题「DSH 掌机」；不要出现旧的
  `dsh-phone-remote` / `dsh-handheld` / `dsh-wand` / 「遥控棒」字样。
- 端口：7788–7795 自动顺延；`/info` 除 `{ok,port,host,url,phonesOnline,
  bridgeOnline}` 外还可带服务器诊断字段（`stateReceived` 等），勿删。

## 6. Git 与发布

- 直接 main 开发即可（单作者小仓库）；提交信息说明"改了什么 + 为什么"。
- 安装通道是 **git**：`dsh plugin --profile web add github:zingzheng/dsh-gb` —
  零构建安装依赖 `lib/client.js` 已提交 + 无 prepare 脚本（约束见 §2-4）。
- 发布前检查：`package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`、
  `dsh.client.inject` 以 `@deepseek-ai/dsh-client-runtime` + `dsh-client-ui-slots`
  开头、`files` 含 `lib` + `cordis.patch.yml` + `README.md`（LICENSE 自动包含）。
