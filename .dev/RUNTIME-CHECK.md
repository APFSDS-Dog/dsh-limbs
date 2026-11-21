# 重启后运行时验证清单 · dsh-limbs 模块三

> 写于 2026-11-16 19:18。离线 54 条断言已全过，只差运行时。
> 重启 DSH 后，新会话照这份清单走一遍即可。

## 为什么必须重启

`lib/host.js` 是 Host 半。Host 插件不会像 client 那样刷新页面就重载，
当前进程加载的还是改动前的空 `apply()`，所以工具没注册。

已确认（改动前）：

```
cordis_inspect_query → Tool.listTools → 没有 analyze_conversation_efficiency
```

## 验证步骤

### 1. 工具是否注册

新会话里调用只读查询：

```
cordis_inspect_query
  platform: host
  provider: Tool
  method:   listTools
```

预期：结果里出现 `analyze_conversation_efficiency`。

### 2. 插件 entry 状态

```
cordis_inspect_query
  platform: host
  provider: Config
  method:   listConfigs
  input:    {"name": "dsh-limbs"}
```

预期：`include:dsh-limbs` 的 `status` 仍为 `absent`
（`absent` 只表示该 entry 没有 Config schema，**不代表未加载**）。

### 3. 实跑一次报告

在本会话调用 `analyze_conversation_efficiency`（参数 `top_n` 可省）。
预期：返回一段 Markdown，含「总账 / 费用大头 / 效率诊断 / 效率评分 / 优化建议」。

### 4. 投影是否真的读到了

报告里出现以下任一，即说明 `dsh-context` 的 `contextTimeline` 投影接通了：

- 总账里有一行 `| 费用 | $x.xxxx |`
- 多出一节「上下文构成」，含「工具结果」行

若两者都没有：降级路径生效了（不报错但拿不到金额），需要排查第 5 条。

### 5. 投影排查（仅当第 4 条未通过）

`dsh-context 0.85.1` 已确认在 `dsh.profile.bundles` 里。若金额缺失，可能原因：

| 可能原因 | 怎么确认 |
|---|---|
| `dsh-context` 该会话还没折出 `costRead` | 打开它的上下文面板看有没有金额 |
| 当前模型不在它的价格目录里 | `costRead.usd` 会是 `null`，属正常降级 |
| `ctx.get('sessionProjections')` 取不到 | 需要看 Host 日志有没有抛错 |

## 已知的失败面（按概率）

1. **`ctx.get('sessionProjections')` 在未 inject 时返回 undefined**
   → 只影响金额与构成，工具本身照常工作。
2. **投影的 `viewSchema` 校验把 `contextTimeline` 摘掉**
   → 同上，静默降级，不炸。
3. **`ctx.tools.register()` 抛错**（output/schema/timeoutMs 不合法）
   → 插件不生效，`listTools` 里看不到工具，但 DSH 本身正常。

## 验证通过后要做的

1. 写 `/limbs-review` 命令（第二个入口，`ctx.commands.register`）
2. 改 `README.md`：现在只讲模型选择器，完全没提模块三
3. 追加 `PROJECT_PROGRESS.md`（只追加，不重写历史）

## 关键文件

| 文件 | 说明 |
|---|---|
| `lib/host.js` | 分析器本体，`fetchTraceData` / `analyzeData` / `generateMarkdown` 均已 export |
| `.dev/postmortem-test.mjs` | 离线测试，54 条断言；`--print` 会打印一份样例报告 |
| `cordis.patch.yml` | 已更新 Host 半的注释说明 |

离线复跑：

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\postmortem-test.mjs
```
