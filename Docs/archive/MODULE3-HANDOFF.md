# 模块三 · 事后复盘分析器 · 交接

> 最后更新：2026-11-16 19:25
> 范围：只讲 `dsh-limbs` 的**模块三**（复盘分析器）。模型选择器（模块一/二）见 `PROJECT_PROGRESS.md`。
> 状态：**代码完成、离线验证通过、运行时待验证**（差一次 DSH 重启）。

---

## 一、一句话定位

对话结束后，只读当前会话的事件日志，算出「token 花在哪个工具上」，找出浪费模式，给评分和可执行建议。
不写日志、不联网、不发模型请求。

---

## 二、数据源真相（最容易被带偏的地方）

### 2.1 本机实际装了什么

`D:\Apps\DSHData\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里有：

| 包 | 版本 | 与模块三的关系 |
|---|---|---|
| `dsh-context` | 0.85.1 | 注册了 `contextTimeline` 投影，**模块三的金额与上下文构成来自它** |
| `dsh-cost-meter` | 1.9.68 | 纯 UI + 私有账本，**没有对外 Service**，模块三没有依赖它 |

⚠️ 这两个包在 `cordis.patch.yml` 里搜不到——它们是通过 `dsh.profile.bundles` 挂的。
**查 profile 装了什么是看 `package.json`，不是看 `cordis.patch.yml`。**（我在这里误判过一次，白绕了一圈。）

### 2.2 两级数据源

```
contextTimeline 投影  →  金额、类别构成、每工具耗时（事件流算不出来）
会话事件流            →  每次调用的精确结果字节、参数、报错（投影里没有）
```

两者互补，不是二选一。投影读不到时**静默降级**，功能完整、不报错，只是少了金额和构成。

---

## 三、API 速查（可直接抄，均为实测核对）

### 3.1 拿会话与事件

```js
const session = ctx.sessions.get(agent.id)   // agent = { id: SessionId }
const events  = session.ownEvents()          // 本会话自己的事件，不含 fork 继承
```

### 3.2 三个必需事件

```js
'tool/call'         { turn, step, callId, name, arguments }   // arguments 是原始 JSON 字符串
'tool/result'       { turn, step, message, error?, meta? }    // message.content 是 ContentBlock[]
'assistant/message' { turn, step, message, usage?, ... }      // usage 是 TokenUsage 的唯一来源
```

**没有独立的 usage 事件。** `tool/call` / `tool/result` 上一个 token 字段都没有。

`TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`

### 3.3 读 dsh-context 投影

```js
ctx.sessionProjections.snapshot(session, ['contextTimeline']).values.contextTimeline
```

拿到的是 `Snapshot`（结构见 `dsh-context/lib/index.d.ts`）。模块三只用这几个字段：

| 字段 | 内容 |
|---|---|
| `costRead.usd` | 美元金额；模型不在价格目录里时为 `null` |
| `current.{system,tools,user,inject,skill,assistant,tool,total}` | 上下文按类别拆分 |
| `timing.tools[name].{calls,ms}` | 每工具耗时 |
| `commands[].outChars` | 终端命令输出字符数 |
| `fileOps[].read.{start,count}` | 读文件是否带了范围 |

### 3.4 注册两个入口

```js
ctx.tools.register({
  name, description, parameters,        // parameters 是普通 JSON Schema，register **不校验**它
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text }] },
  timeoutMs, execute: async (args, exec) => '...',
})

ctx.commands.register({
  name: 'limbs-review',                 // 不带斜杠
  description, input: { hint },
  handler: invocation => ({ kind: 'success', text }) | ({ kind: 'error', text }),
})
```

`register()` 只强制校验 `output.schema`（`assertSupportedJsonSchema`）与 `timeoutMs`（正数）；
`output.render` 必须是函数。name 不能是保留名 `run_code`。

---

## 四、代码结构

`lib/host.js` 是单文件（977 行），刻意**不 import 任何 `@deepseek-ai/*` 包**——
第三方插件在 profile 下能否解析到 dsh 安装内的包没有实测过，而 `ctx.tools.register()`
接受纯对象，零依赖最稳。

| 导出 | 作用 |
|---|---|
| `inject` | `['tools', 'commands', 'sessions']` |
| `fetchTraceData(ctx, agent)` | 读事件流 + 投影，产出归一化轨迹 |
| `analyzeData(trace, { topN })` | 归因、诊断、评分、建议 |
| `generateMarkdown(analysis)` | 渲染报告 |
| `reviewConversation(ctx, agent, topN)` | 上面三步串起来，工具与命令共用 |
| `apply(ctx)` | 注册两个入口 |

三个内部要点：

- `readContextProjection()` 用 `ctx.get('sessionProjections')`（**不声明 inject**，因为要允许它缺席），
  `snapshot` 抛错也吞掉降级。
- `distributeAttribution()` 把一个 token 增量按各工具结果字节数比例分摊，最后一个吃余数并夹到 ≥ 0。
- 章节号用 `sectionCursor` 自适应：没有投影数据就不占号，读者不会看到跳号。

---

## 五、验证状态

### 已通过（离线，70 条断言）

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\postmortem-test.mjs
```

覆盖：差分归因（14000 增量按体量分摊给 3 个 read）、5 条诊断规则、评分、投影接入、
三种降级路径（缺失 / 抛错 / 无服务）、两个入口的注册形状、命令 handler 的成功与失败。

### 未通过（运行时，需要你重启 DSH）

Host 半的改动**刷新页面不重载，必须重启**。当前进程加载的还是旧的空 `apply`。
验证步骤见 `.dev/RUNTIME-CHECK.md`。

三种可能结果：

| 现象 | 说明 |
|---|---|
| 工具出现 + 报告有金额行 | 全通 |
| 工具出现、无金额行 | 事件流降级生效，`ctx.get('sessionProjections')` 没取到 |
| 工具根本不出现 | 注册阶段抛错，查 Host 日志 |

---

## 六、踩过的坑（别再踩）

1. **`definePlugin` 在本机 DSH 里不存在。** `app.asar` 2332 个源文件全量扫描命中 0 次。
   正确写法是命名导出：`export const inject` + `export function apply(ctx)`。别被这个名词带偏。
2. **`exec` 上没有 `ctx`。** `ToolRunContext` 只有 `callId / arguments / agent / signal`，
   服务必须靠 `apply(ctx)` 的闭包带进 `execute`。
3. **`inputTokens` 是整段前缀总量，不是增量。** 直接按步累加会重复计费、虚高到没法看。
   必须用差分（第 N 步 − 第 N−1 步）归给第 N−1 步的工具。
4. **`listConfigs` 是分页的。** 本机 217 条，要翻 3 页才算看全（`limit` 最大 100）。
   我只看前 200 条就下过「没有 dsh-context」的结论，是错的。
5. **entry 的 `status: "absent"` 不代表没加载**，只表示该 entry 没有 Config schema。
   插件是否在跑要看 `dsh.profile.bundles`。
6. **`dsh-cost-meter` 没有对外 Service。** 想读它的账本只能逆向它的存储格式，版本一升就断，别碰。
7. **同一批调用会被多条诊断同时命中**（全量读大文件往往也是重复调用）。
   报告里第二条起会标「与上一条为同一批调用，不重复计入」，别让读者把两行 token 加起来。
8. **第三方插件不能做硬依赖。** 投影读不到必须能降级，否则用户卸了 `dsh-context` 模块三就废了。

---

## 七、下一步

1. **重启验证**（最高优先级）——清单在 `.dev/RUNTIME-CHECK.md`。
2. **用真机数据校准 `THRESHOLDS`**：现在 8KB / 20KB / 30KB / 3 次是估的，
   跑几次真实会话后按实际分布调。
3. **可选增强**：`costRead` 里还有 `cacheRead / cacheWrite / uncached / output` 分桶没接，
   接上能算出「缓存帮你省了多少」。
4. **可选增强**：如果希望分析结果跨 reload 保留，可以自己 `ctx.sessionProjections.register`
   一个投影键（框架的公开扩展点），而不是每次现算。

---

## 八、相关文件

| 文件 | 说明 |
|---|---|
| `lib/host.js` | 分析器本体 |
| `lib/client.js` | 模块一/二的模型选择器（本次未改动） |
| `.dev/postmortem-test.mjs` | 离线测试，70 条断言；`--print` 打印样例报告 |
| `.dev/RUNTIME-CHECK.md` | 重启后的验证清单 |
| `README.md` | 已加「模块三」一节 |
| `package.json` | 版本仍为 0.1.0；发版前记得抬版本 |
