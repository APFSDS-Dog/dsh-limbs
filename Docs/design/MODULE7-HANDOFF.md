# 模块七 · 交接（Handoff）· 交接文档

> 写下时间：2026-11-20 16:10（Asia/Hong_Kong）｜ §五 核实更新：2026-11-20 17:00
> 用途：换 Agent 接手时先读这一份，不用翻聊天记录。
> 范围：只讲**要新增的模块七**。模块一（composer 模型座位）、模块二（模型管理）、模块三（复盘分析器）、**模块四（上下文及时整治，已规划未开工）**—— 四个**一律不动**。
> 状态：**设计已定，一行代码未写。** 本文是设计方的交接，不是施工记录。
> ✅ **API 已对着 `0.2.2-rc.5` 源码全部核实**（§五）：注入走 `agent/pre-step`，**不是** `systemPrompt.section()`。照旧版假设施工会做出多项目串话的模块。

---

## 一、一句话

把这个插件从「手脚」扩到「记忆」——新增**模块七 · 交接**：让每个项目的**任务账**（做过什么、到哪一步）跨会话活着，且**只有项目主说「任务收尾」时才允许写**。

> **和模块四的边界（别撞车）**：模块四管**会话内**的上下文及时整治（长度逼近上限时就地压缩）；
> 模块七管**跨会话**的落盘与重建（收尾时写进工程文件、下次开会话注入）。
> 一句话：**模块四治"这一段对话太长"，模块七治"下一个会话不知道上一步"** —— 两者互为兜底，但不互相调用。

---

## 二、设计从哪来（唯一源，别在别处重述）

| 文件 | 位置 | 装什么 |
|---|---|---|
| 决策记录 | `E:\冷储存库\proj-scaffold-kit\交接机制-决策记录.md` | **D0–D3 已定条目**；U3 / U5 / U6 已随本文 §五 关闭，**只剩 U7**（已上账为账本 `§3.3 Q4`） |
| 设计基线 v0.2 | space 文档《对话交接-设计基线-v0.2》 | 讨论过程、C1–C10 共识、M/D/K 未合并分歧 |

> ⚠️ **只认决策记录**。v0.2 里 M1 / M6 已被否决、U1/U2/U4 已定，照 v0.2 施工会走回头路。

---

## 三、三段子模块（都在模块七里，**不要拆成三个插件，也不要拆成三个 `模块`**）

> 叫「段」是为了跟仓库里的 `模块N` 区分开：模块七是**一个**插件模块，里面分三段。

| 段 | 职责 | 是否要写 UI |
|---|---|---|
| `assemble` | 渲染**热层四段**，经 `agent/pre-step` 注入（**不是** system prompt 区段，见 §5.1） | ❌ 不要 |
| `commit` | 收尾：校验令牌 → 生成 `id` → 写 devlog → upsert 账行 → 跑自检 | ❌ 不要 |
| `lookup` | 按 `id` 取冷存档、按关键词 grep 账表 | ❌ 不要 |

> 🔴 **模块七不需要 `client.js`**。`dsh.client` 只在要挂槽位/页面时才写；模块七纯 Host 半边，别去动 `lib/client.js`，否则会把模块一/二/三的槽位优先级牵连进来。

---

## 四、硬契约（这几条是已拍板的，**不要重新讨论**）

### 4.1 触发权归人（D0）

| 谁 | 做什么 |
|---|---|
| 项目主 | 说「任务收尾」—— **唯一**触发方式 |
| agent | 决定这次写什么内容 |
| 程序（本模块） | 发一次性令牌、生成 `id`、按模板写盘、跑自检 |

**程序只能提醒，不能触发**：检测到本轮动过文件 → 可以提示「要不要收尾」；**不许**监听账表状态变 `done` 就自动写盘。

### 4.2 口令即授权（D0-1）

- 口令 = **发一个一次性令牌**，用掉即作废
- **没有令牌时，对 `Docs/devlog/`、`PROJECT_PROGRESS.md` 的写入必须被拒**（这是本模块存在的核心理由）
- ⚠️ 令牌的正位是**授权**，去重只是副作用 —— 别把它做成"内容哈希去重"

#### 4.2.1 令牌的两个入口（2026-11-25 补：修死锁）

原设计里令牌**只能由人**通过 `/limbs-handoff-token` 发。实测下来这是死锁：模型调不了
`ctx.commands`，项目主说「任务收尾」后模型仍然拿不到令牌，只能人工代跑命令 ——
四道闸退化成"半自动"。

改法（**D0-1 不变，只是把"谁发"换成"按什么判"**）：

| 入口 | 谁按 | 判据 |
|---|---|---|
| `handoff_request_token`（工具） | 模型自己调 | **本轮 user message 里有没有授权语** |
| `/limbs-handoff-token`（命令） | 人 | 无判据，永远可用（人工兜底） |

**为什么模型没法自问自答**：它只能写 assistant 文本 / tool-call / tool-result，改不了
user message；而判据只看 user message。所以「一句话 = 一次授权」成立。

判据三条，缺一即拒（细节与坑见 `lib/handoff.js` 的 `authorizationFromTurn`）：

1. **只能看本轮** —— `ctx.agents.turnBoundaryOf(session).openTurnStartSeq` 之后的事件。
   上一轮说过口令不算本轮授权。
2. **只能看人** —— `source.kind === 'user'` **且有 `rpcId`**（官方 `'user-rpc'` 源）。
   热层自己注入的消息也是 `kind: 'user'`（`createLocalUserMessage`），正文里还写着
   「要收尾请项目主说「任务收尾」」—— 只按 kind 判 = 热层自己授权自己。
3. **只能看本次会话自己的** —— 跳过 `inheritedEventCount` 之前的 fork 继承前缀；
   `header.origin === 'subagent'` 直接拒（子代理不能替项目主签字）。

口令判据是**「整句就是口令」**，不是「包含口令」：

- ⚠️ 真机实测踩到的坑：本轮任务描述里写着「项目主说「任务收尾」后，agent 无法自己拿令牌」，
  按子串判就被判成授权 —— 一发令牌就成了**模型给自己发**，正好把 D0-1 破掉。
- 现在只认「两侧剥掉纯语气字后整串等于口令短语」（「任务收尾」「收尾吧」「好了，任务收尾吧」）。
  夹在长句里的、被引号包住的、带"我说"之类前缀的，一律不认。
- **宁可漏认**：漏认的代价是项目主再说一遍；误认的代价是绕过授权。

令牌本身多了一条 **30 分钟 TTL**（`expiresAt`，缺这个字段的老记录一律当过期，fail-safe）。
过期 / 跨会话 / 用过 / 值不符，四种拒绝理由都含「缺口令」前缀，好让模型和人一眼认出这是令牌闸。

### 4.3 `task_id`（D1）

```
t-YYYYMMDD-NN        NN = 当天第几个任务，01 起
```

| 项 | 结论 |
|---|---|
| 一个 id = | 一次收尾 = 一份 devlog = 账表一行 |
| 谁生成 | **程序**，扫**两处**取当天最大 NN 再 +1：① `Docs/devlog/` 的文件名 ② `PROJECT_PROGRESS.md` 账表里的 `id`。**人不编号** |
| 排序 | 字典序 = 时间序（所以前缀必须是 `t-`，不能是纯日期） |
| 幂等三层 | 令牌一次性 · 同名 devlog 拒写 · 账行按 id upsert |

### 4.4 文件边界（D2）—— 三份文件 + 一个视图规则

| 文件 | 装什么 | 谁写 |
|---|---|---|
| `AGENTS.md` | 硬契约（DSH 已整份注入，**不要重复注入**） | 人 |
| `PROJECT_STATUS.md` | 稳定事实 + 地图 | agent |
| `PROJECT_PROGRESS.md` | **任务账**：六列 + §3.3 待拍板 | 本模块 |
| `Docs/devlog/t-*.md` | 单任务全过程 + 证据 | 本模块 |

**账行六列**：`id` / 标题（≤15 字）/ 状态 / 结论（≤20 字）/ 存档 / `next`
**状态四值**：`done` / `doing` / `blocked` / `dropped`

> 🔴 **不许新建「流水账」文件，也不许新建「批次交接」目录** —— 滑窗是**渲染时的视图**，不是存储形态。
> 全量账行就存在 `PROJECT_PROGRESS.md` 里，`check_docs.py` 已把它列入 40KB 上限豁免。

### 4.5 热层四段（`assemble` 的输出，按「缺了就会问重复问题」排序）

1. 账表**最近 10 行**（id / 标题 / 状态 / next）
2. `§3.3` 待拍板**全部，不剪**
3. `PROJECT_STATUS.md` §二 实测快照（带核对日期）
4. 最新一份 devlog 的「遗留问题与下一步」段

粗估 3~5 KB。**`AGENTS.md` 已由 DSH 整份注入，装配器不要再注入契约。**

---

## 五、五件事已全部核实（2026-11-20，对着 `0.2.2-rc.5` 源码验证）

> 原版这节写的是「我这边验不了，你去隔着版本确认」。**已全部验掉，结论如下。**
> 环境：DSH Desktop `0.2.2-rc.5`（`@deepseek-ai/dsh@0.2.2-rc.5`），只读查 `app.asar`。
> ⚠️ **第 1 项的原假设是错的，已改**——照旧版施工会做出一个多项目串话的模块。

### 5.1 注入：**不要用 `systemPrompt.section()`，用 `agent/pre-step`**（原假设作废）

| | `ctx.systemPrompt.section()` | `ctx.on('agent/pre-step')` ✅ |
|---|---|---|
| API | 存在，`@deepseek-ai/dsh-system-prompt` | 存在，官方 AGENTS.md 注入就走这条 |
| 能否带 cwd | ❌ **不能**，`PromptSection` 是 `{name, order, text}`，注册落在插件所在 scope，**全局** | ✅ 回调里有 `agent`，`agent.session.header.cwd` 可读 |
| 后果 | 按原计划写 → A 项目的任务账注入到 B 项目会话 | 天然按工作区隔离，正是 U5 要的 |

**官方实现就摆在那**，`@deepseek-ai/dsh-agent-instructions/src/index.ts:330`：

```ts
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
  const decision = await next()
  const desired = await compose(agent, signal, messages, pending) // 内部读 cwd
  // 空首轮不要占轮：把上下文挂到 inbox 待命
  if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
    syncInbox(agent, messages, desired)
    return decision
  }
  const i = decision.messages.findLastIndex(m => messages.includes(m))
  return { ...decision, messages: decision.messages.toSpliced(i + 1, 0, desired) }
})
```

配套三件（同一文件）：`createUserMessage({ content, source })` 造消息、`agent.inbox.prepend('next-step', msg)` 暂存、`sameContextPayload()` 做幂等去重。

**要点**（照抄官方，别自创）：
- 注入位次 = **紧跟用户提问之后**、驱动追加的 runtime context 之前
- `step === 1` 且 `decision.messages.length === 0` 时**不要**把上下文变成独立请求，挂 inbox 等下一轮
- 去重靠整条 `UserMessage` 深比较，不是内容哈希
- **`AGENTS.md` 已由它整份注入**，装配器别再注入契约

### 5.2 工具注册：`ctx.tools.register(definition, options?)` ✅

`@deepseek-ai/dsh-tools/src/index.ts:128`。`ToolDefinition extends ToolSchema` 且**必须**声明 `output`：

```ts
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition         // 必填：canonical 输出声明
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>  // 只返回 lossless-JSON
  // 可选：projectContent / finalizeContent / timeoutMs / isConcurrencySafe / presentCall / presentResult
}
```

- 返回的是**精确的 disposer**（`() => void`），跟 `ctx.effect` 一致，卸载即注销
- 重名会抛错；要 per-agent 变体走 `agent.ctx` 注册，**不是**在全局重名
- `RUN_CODE_NAME` 是保留名，不能注册或遮蔽
- `ToolsService` 自身 `static inject = ['systemPrompt']`

**写文件不是这个 API 的事**：`execute` 只返回 JSON 值。真要写盘得用 `ctx.fs`（`@deepseek-ai/dsh-fs`）或 `node:fs`，权限由 5.3 的 policy 决定。

### 5.3 权限档：`ctx.sandboxPolicy.resolve()` ✅（这条最要紧）

`@deepseek-ai/dsh-sandbox-policy/src/index.ts:208`，服务名 `sandboxPolicy`：

```ts
const policy = ctx.sandboxPolicy.resolve({ session })   // 传 session 才是"本会话"的策略
policy.mode          // 'read-only' | 'workspace-write' | 'danger-full-access'
policy.workspaceRoot // workspace-write 可写的边界 = session.header.cwd
```

优先级（源码注释原文）：**显式 mode 覆盖 > 会话最后一条 `sandbox/mode` 事件 > 部署默认值**。
`workspaceRoot` 取自 `session.header.cwd`；cwd 缺失才回退到配置的根；cwd 是相对路径或含 NUL 会抛 `SandboxInvalidRootError`。

**必须这么用（否则就是那个"静默失败"）**：

```ts
if (policy.mode === 'read-only') {
  throw new Error('当前会话是 read-only，任务收尾要写 Docs/devlog/ 与 PROJECT_PROGRESS.md；请切到 workspace-write 再喊一次口令。')
}
```

- 部署默认值是 **`read-only`**（fail-safe），所以"没配过"不等于"能写"
- `danger-full-access` 不过沙箱，但**不等于**该跳过检查——仍要确认目标路径在项目根内
- 目标是项目根之外（如 `E:\冷储存库\`）时，`workspaceRoot` 不覆盖它，需要 `ctx.sandboxPolicy.registerWritableRoot(session, dir)`（返回 disposer，**resume/fork 后要重新挂**）。

### 5.4 插件 Config schema：`export const Config: z<Config> = z.object({...})` ✅

用 `@deepseek-ai/schemastery`（官方统一用它，不是 zod）。范例 `dsh-agent-instructions/src/config.ts:41`：

```ts
import z from '@deepseek-ai/schemastery'
export interface Config { maxBytes: number; enabled?: boolean }
export const Config: z<Config> = z.object({
  maxBytes: z.number().required(),
  enabled: z.boolean().default(true),
})
```

- 默认值写在 schema 里（`.default()`），**不要在 `apply()` 里再兜一遍**
- 可选字段在 interface 上标 `?`，schema 里给 `.default()`

### 5.5 状态目录：`ctx.get('dshHomePath')` ✅

`@deepseek-ai/dsh-app-boot/src/index.ts:1243` 有 `ctx.provide('dshHomePath', dshHomePath)`，来自 `@deepseek-ai/dsh-home-paths`：

```ts
ctx.get('dshHomePath')('dsh-limbs', 'handoff-tokens.json')  // → <DSH_HOME>/dsh-limbs/handoff-tokens.json
```

- `DSH_HOME` 环境变量 > 默认 `~/.dsh`；本机是 `D:\Apps\DSHData`（`~/.dsh` 是它的 Junction）
- 同包还有 `resolveDshHome()` / `dshCachePath()`（后者给可丢弃的缓存）
- **令牌落这里，不要落项目里**——令牌是"这台机器 + 这次会话"的授权凭据，进 git 就是安全事故
- 目录惯例照**模块二**：`<DSH_HOME>/dsh-limbs/model-settings.json`。别另造目录，同插件共用一个 `dsh-limbs/`。
- ⚠️ **一处实现差异，别照抄**：现有 `modelSettingsFile()`（`lib/host.js:81`）是直接读 `process.env.DSH_HOME`，
  没设时回退到 `tmpdir()/dsh-home`。本机 `DSH_HOME` 有设所以能用，但**回退到临时目录意味着"重启就丢"**。
  模块七的令牌**必须**用 `ctx.get('dshHomePath')`（服务提供的解析器，含 `~` 展开与规范化），
  回退成临时目录的令牌在 DSH 重启后就失效了——那正是"喊了口令却说没权限"的坑。

### 5.6 项目级配置（U5）—— 结论不变，但依据更硬了

`.dsh/handoff.yaml`（缺失即用默认值）。插件全局安装，**配置必须落项目里**，否则多项目串话。

> 现在这条有双重保障：5.1 让注入天然按 cwd 隔离，`.dsh/handoff.yaml` 只管项目自己的开关项（比如某项目要不要收尾提醒）。**别把隔离的希望全押在配置文件上。**

---

## 六、建议的落地顺序（降风险，不是拖延）

1. **`assemble` 先行**（只读不写）——注入对了，上下文的问题就解决了一半，且零破坏风险
2. **`lookup` 其次**（只读）——按 `id` 取存档、grep 账表
3. **`commit` 最后**，且**第一版只 dry-run**：算出 id、拼出要写的两个文件内容、**打印出来不落盘**
4. dry-run 跑过 3 次真实收尾后，再打开真写

理由：`commit` 是唯一会改工程文件的动作，它错了会污染台账；前两级纯读，随时可回滚。

---

## 七、验收标准（怎么写才算完）

- [ ] 说「任务收尾」→ 生成 `t-YYYYMMDD-NN`，**同一天第二次收尾得 `-02`**
- [ ] 重复喊口令 → **不产生第二份 devlog、不重复账行**
- [ ] 没说口令就尝试写 → **被拒**，并说明"缺口令"
- [ ] 账行六列齐全，状态只用四值
- [ ] `python check_docs.py` → **新增的红项为零**（`任务账格式合法` 这项必须 ✅）
- [ ] 卸载插件后 → `ctx.effect` 清干净，不留槽位/监听/样式
- [ ] 只读工作区下写入 → **明说失败**，不静默

---

## 八、别踩的坑

**#1 · 别在插件里重造一套文档格式**
工程里已有 `check_docs.py` 在守 `PROJECT_PROGRESS.md` / `INDEX.md` 的规则。插件再写一套，就成了两个以单源为名的写入器。
→ **写完必须跑 `check_docs.py`，红了就抛错、不静默**（决策记录 U7）。

**#2 · 校验要认「位置」，不能认「内容」**
设计方这边踩过：第一版自检只认"以 `t-` 开头的行"，结果 `task-1` 这种坏 id **整行漏检**，格式错了反而不报红。
→ 认行要靠**位置**（首格反引号 + 至少六列），靠内容就是假阴性。

**#3 · 阶段收尾也是任务**
`proj-stage-closeout` 的阶段总结同样用 `t-*_阶段总结_<阶段名>.md`，也在账上占一行。
否则 `devlog/` 里混着两种前缀，**字典序 = 时间序**这条就断了。

**#4 · 别照 v0.2 基线施工**
M6（程序监听状态自动触发）已否决、M1（人工确认点）已降级为提示。照旧文会做出一个抢判定权的模块。

**#5 · 别用 `systemPrompt.section()` 做按项目注入**（2026-11-20 核实新增）
它没有 cwd 参数，注册是**全局**的。用它做 `assemble` = A 项目任务账注入到 B 项目。
→ 走 `ctx.on('agent/pre-step')`，官方 `dsh-agent-instructions` 就是这么做的（§5.1）。

**#6 · 「没配过」不等于「能写」**
`sandboxPolicy` 的部署默认是 **`read-only`**（fail-safe）。不显式读 `resolve().mode` 就写盘，
结果不是报错而是**静默什么都写不进去**——正好是这份文档 §7 最后一条要挡的事。
→ 写之前先读 policy，`read-only` 直接抛出带中文指引的错误（§5.3）。

**#7 · 本文件未提交**
按约定只改文件、不代提交。要不要入库由阿昆定。

**#8 · 「能读到本轮 user message」不是假设，是验过的**（2026-11-25 补）
工具回调里读本轮消息 = `exec.agent.session.snapshotEvents()` + `ctx.agents.turnBoundaryOf(...)`，
两者都是官方现有读口（`dsh-tool-goal/src/authority.ts:33` 就是这么写的）。`snapshotEvents()`
虽被官方标 deprecated，但没有任何「本轮消息」的 Service 替代品，官方插件自己在用。
→ 真机验法：在运行中的会话里调一次 `handoff_request_token`，看它发出的令牌里
   `reason` 字段记下的短语是不是本轮真实口令。**别只跑离线测试就断言"能读到"**。
（本节是补记，原文 §八 的 #7 仍是"未提交"那条，编号没挪。）

---

## 九、给接手方的一句话

**先读决策记录，再读本文件；只做 `assemble` → `lookup` → `commit(dry-run)` 三级，每级跑通再进下一级。**

§五 的五个 API 已全部核实（对着 `0.2.2-rc.5`），可以直接开工，不必再"隔着版本猜"。
仍未定的**只有 U7**（与 `check_docs.py` 的双写入器）—— **已上账为 `PROJECT_PROGRESS.md` §3.3 的 Q4**，别在这里重新讨论；U5 已在 §5.6 关闭；
U3、U6 已随 §五 关闭。**不确定就翻决策记录 §四，别人已经踩过的别再自己拍。**
