# dsh-billing（DSH 计费显示）

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

DSH 的**会话花费 + 账户余额显示插件**：在**合成器工具行里、模型选择器
（`DeepSeek-V4-Flash-Vision-Exp High`）左边那一格**，显示

```
￥110.00/1.72/0.011
```

三个数依次是：**账户真实余额 / 本会话总花费 / 每步花费**（每步 = 总额 ÷ 步数）。
字号与行高跟旁边的模型选择器完全一致（13px / 20px）。

鼠标悬停在文字上会按同样顺序说明这三个数、用的是哪个模型、哪三档单价；
余额取不到时会写明原因（如 `no-credential`）。

- 加载时什么都不显示；**本会话一个计费 token 都没有时也不显示**（不出现「￥0」）。
- 没有步数时省掉最后一格：`￥110.00/1.72`。
- **余额取不到时省掉第一格**：`￥1.72/0.011`（此时悬停会说明为什么取不到）。

## 安装

本包是一个 **DSH 组合包（bundle）**：`package.json` 里声明了
`dsh.bundle.patch`，由 `cordis.patch.yml` 插入插件行。所以两种装法都行：

```powershell
# 方式一：官方 CLI（推荐）——自动写入依赖并登记进 dsh.profile.bundles
git clone https://github.com/jiutianyisui/dsh-billing.git
dsh plugin --profile web add .\dsh-billing

# 方式二：仓库自带脚本（内部就是调上面那条命令）
cd dsh-billing
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

装完**刷新页面**；没出现就重启 `dsh web`。卸载：

```powershell
dsh plugin --profile web remove dsh-billing
# 或：powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

装好后 `%USERPROFILE%\.dsh\profiles\web\package.json` 会出现：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-billing"] } },
  "dependencies": { "dsh-billing": "link:E:/path/to/dsh-billing" }
}
```

> **为什么必须声明 `dsh.bundle.patch`**：DSH 把 `dsh.profile.bundles` 里的每个包
> 当作一个组合层加载；包若没有 `dsh.bundle`，`dsh plugin add` 会以
> `not-a-bundle`（`declares no dsh.bundle`）拒绝安装，启动时也只当成普通依赖。
> 另：`dsh.client.platform` 与 `dsh.bundle` **同时存在**——前者让浏览器半被扫描进
> `window.__DSH_BOOT__`，后者让 Node 半成为一个组合层。
>
> **不要手工往 profile 的 `cordis.patch.yml` 插块**（旧版 `install.ps1` 的做法）：
> 那条路径绕过了 `dsh.profile.bundles`，pnpm 下次 install 会把链接丢掉，插件静默消失。


## 账户余额是怎么来的

余额是**真实账户余额**，由宿主半去问 DeepSeek 的官方接口
（`GET https://api.deepseek.com/user/balance`），不是估算：

1. 宿主半用 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` 拿到 key（就是你配置里
   provider 的那个 `apiKeyEnv`）；
2. 带着 `Authorization: Bearer <key>` 查询余额，进程内缓存 10 秒（多个页面共享一次查询）；
3. 挂一个只读路由 `GET /dsh-billing/balance`，**只回数字**：
   `{ ok: true, available, currency, total, granted, toppedUp }`，失败时是 `{ ok: false, reason }`；
4. 浏览器半每 20 秒轮询这个同源路由（`?fresh=1` 可跳过宿主的 10 秒缓存）。

**API key 永远不出宿主进程**：响应体和页面里都不含 key，页面只拿到一个数字。
要换自建/代理端点，改 `src/host.js` 顶部的 `BALANCE_URL`；要换凭据名，改 `API_KEY_REF`。

## 它是怎么工作的

| 半 | 文件 | 干什么 |
|---|---|---|
| Node 半 | `lib/index.js`（源 `src/host.js`） | 让本包成为「活着的 Loader 条目」；查账户余额并挂 `/dsh-billing/balance` 只读路由。 |
| 浏览器半 | `lib/client.js`（源 `src/client.js`） | 页面里的全部逻辑：读投影算钱、轮询余额、渲染文字。 |

页面能拿到浏览器半，是因为 `dsh web` 的 client-modules 服务会扫描活着的 Loader 条目里
声明了 `dsh.client` 的包，把它的 `exports["./client"]` 作为经典脚本投给浏览器
（`window.__ModuleLoader__.load({ id, factory })`）——所以**不需要打包器**，
`src/client.js` 就是 `factory` 的函数体，由 `build.ps1` 包一层壳。

数据全部来自宿主已经算好的**持久投影**（前端只做乘法）：

| 投影 | 用途 |
|---|---|
| `tokenUsage` | 四个互不重叠的 token 桶：`uncachedInputTokens`（未命中）/ `cacheReadTokens`（命中）/ `cacheWriteTokens`（缓存写入）/ `outputTokens`（输出）。跨整段日志累计，分页与压缩都不影响。 |
| `sessionStats` | 步数（`steps`）——每步花费 = 总额 ÷ 步数。 |
| `modelSelection` | 当前路线（`lastUsed.model`），决定用价格表哪一行。 |

金额 = `未命中(含缓存写入) × miss + 命中 × hit + 输出 × out` ÷ 1,000,000。

## 改价（唯一需要改的地方）

打开 `src/client.js` 顶部的 `PRICES`，按 **￥ / 每百万 token** 填三档，然后重新构建：

```js
const PRICES = {
  'deepseek-flash': { miss: 1, hit: 0.02, out: 4 },
  'deepseek-v4-flash': { miss: 1, hit: 0.02, out: 4 },
  'deepseek-v4-pro': { miss: 1, hit: 0.02, out: 4 },
  'deepseek-v4-flash-vision-exp': { miss: 1, hit: 0.02, out: 4 },
  default: { miss: 1, hit: 0.02, out: 4 },   // 表里没有的模型走这行
}
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

当前这组数来自**实测账单**：`deepseek-flash` 的**空闲时段**单价
= 命中 0.02 / 未命中 1 / 输出 4。注意：

- **高峰时段是 ×2**（2 / 0.04 / 8）。插件不知道计价时段，要按高峰算就把三档都乘 2。
- 其余三个模型**没有实测记录**，先沿用同一组数；按你的账单改。
- 缓存命中价只有未命中的 **1/50**，所以命中率高的会话里，钱主要花在**输出**与**缓存读**上，
  而不是「未命中输入」。


## 目录

```
dsh-billing\
├── src\client.js      浏览器半源码（改这里）
├── src\host.js        Node 半源码
├── lib\client.js      构建产物：页面真正执行的那段（勿手改）
├── lib\index.js       构建产物：Node 半
├── cordis.patch.yml   组合包 patch：插入本包的插件行（缺它就不能作为 bundle 安装）
├── tests\smoke.mjs    浏览器半离线冒烟（模拟模块表装载 + 假投影，断言槽位/文本/版式）
├── tests\host.mjs     Node 半离线测试（假 ctx 驱动路由：成功/无凭据/4xx/超时/缓存/key 不外泄）
├── tests\bundle.mjs   清单自检（复现 DSH 的 bundlePatchFiles 校验 + 组合包字段完整性）
├── build.ps1          装配 lib\（无打包器，只做拼接）
├── install.ps1        装进 profile（调 dsh plugin add）
├── uninstall.ps1      卸载
├── LICENSE            MIT
└── .gitignore
```

> **脚本文件务必保持「纯 ASCII 注释」或「带 BOM 的 UTF-8」。**
> Windows PowerShell 5.1 在没有 BOM 时按 ANSI 代码页读取 `.ps1`，
> 中文注释会被解码成吞掉下一行的字节，脚本在解析期就整体失败
> （2026-09-16 实际踩到：`build.ps1` 报 `Value cannot be null. Parameter name: encoding`）。
> 本仓库的三个 `.ps1` 都已存为**带 BOM 的 UTF-8**。

## 构建 / 测试 / 安装 / 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1      # 改完 src 必跑
node .\tests\smoke.mjs              # 浏览器半自检（装载契约 + 金额格式 + 版式回归）
node .\tests\host.mjs               # Node 半自检（余额路由 + 缓存 + 错误分支 + key 不外泄）
node .\tests\bundle.mjs .           # 清单自检（dsh.bundle / exports / files 完整性）
dsh plugin --profile web add .      # 安装（= install.ps1 内部执行的命令）
dsh plugin --profile web remove dsh-billing   # 卸载
```

`install.ps1` 实际只做一件事：调用 `dsh plugin --profile web add <本目录>`。
这条命令由 profile 自己的 pnpm 执行，替我们完成两步：

1. 在 profile 的 `package.json` 里写入依赖
   `"dsh-billing": "link:<本目录>"`（`link:` 让本目录始终是唯一真相，
   改完 `build.ps1` 立即生效，不必重装）；
2. 把 `"dsh-billing"` 追加进 `dsh.profile.bundles`——DSH 据此把本包的
   `cordis.patch.yml` 当作一个组合层加载。

因此**不需要**（也不应该）手工去建 junction 或改 profile 的 `cordis.patch.yml`：
`dsh.profile.bundles` 才是注册插件层的正式途径。装/卸是幂等的，
`package.json` 与 `pnpm-lock.yaml` 都可以手工回滚。

装完**刷新页面**即可；若刷新后仍不出现，重启 `dsh web`
（新插件条目需要新的 Loader 组合）。卸载后同样刷新一次。

## 已知限制

- **按当前模型的单价估算全量**。`tokenUsage` 是整段会话的累计桶，**不带逐模型拆分**，
  所以子代理或中途换模型时，早先那些步会按「当前模型」的价格算。单模型会话完全准确。
  要精确到每一步，得让宿主半边注册一个按 `assistant/message` 的
  `message.source.{provider,model}` 分别计价的投影——那是另一个量级的改动（要动价格配置、
  投影 wire 与持久缓存版本）。
- **缓存写入按未命中输入计价**（DeepSeek 不单独收缓存写入费）。别的计价口径要改
  `src/client.js` 的 `sessionCost`。
- **落点是 `conversation.input.right`**，即合成器工具行里、模型选择器左边那一格
  （ui-conversation `InputBar` 的 `.trailing`，flex + `gap: 12px`）。做成一个行内 `<span>`，
  宽度与间距全交给那一行，所以它和旁边的模型名读起来是一组。
  ⚠️ **不要再挪去 `conversation.composer.dock`（统计条那一行）**：那个槽位每个条目**独占一行**，
  挤不进 `StatsPills` 的行内；用负外边距硬叠会盖住「缓存命中 xx%」（2026-09-16 踩过两次，
  `tests\smoke.mjs` 里已加回归断言：不得撑满整行、不得负外边距）。
- 这个位置**只在有会话时存在**（槽位 scope 是 session）；工具行很窄时它会跟整组右侧控件
  一起换行，不会挤掉模型名或发送键。
- **余额那格依赖三件事**：本机能否访问 `api.deepseek.com`、`DEEPSEEK_API_KEY` 能否解析、
  账号是否在官方端点（自建/代理端没有 `/user/balance`）。任一条不满足就只显示后两格，
  不影响会话花费的准确性。余额 20 秒轮询一次，所以刚花掉的钱最多晚 20 秒才反映到余额上
  （会话花费是投影驱动的，立刻更新）。
- 余额**只读不写**：插件不会去充值、不会改账号设置，只调用那一个 GET 接口。
