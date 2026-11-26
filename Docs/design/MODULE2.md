# 模块二 · 档位化交互与模型管理

> 🔴 **状态（2026-11-26）：已缩水。** 上下文挡位（300K / 600K / 1M）与档位条滑杆（`LevelSlider`）
> **整块删除**，理由与决定见 [PRD.md](PRD.md) §5「模块 2 —— 不做」。本文保留改动前的设计记录，
> 下文凡提到「上下文长度」「滑动条」「轨道 / 刻度」的段落**均已失效**，只作历史参考。
> 现在页面只剩：当前模型（只读）+ 「恢复默认」；设置页只剩「默认推理强度」下拉与「费用超限时提示」开关。
> 相关文件：[lib/client.js](../lib/client.js)、[lib/host.js](../lib/host.js)、[lib/model-management/levels.js](../lib/model-management/levels.js)、[.dev/model-management-test.mjs](../.dev/model-management-test.mjs)

## 一、定位

把模型管理从「一堆英文下拉和术语」改成单页、全中文的档位面板：

- 推理挡位：关闭 → 服务商默认 → 低 → 中 → 高 → 最高（可选）—— **推理档位的真实交互在输入框模型选择器底部的 chips，不在本页**
- ~~上下文长度：300K → 600K（默认）→ 1M~~ —— **已删（假控件，从未进模型请求）**

模块一（composer 模型座位）与模块三（复盘分析器 / 设置壳子）保持原行为；模块二只新增一个设置分区和一条保存接口。

## 二、接入方式

| 接入面 | 值 | 说明 |
|---|---|---|
| 设置分区 | `settings.section`，`id: 'limbs-model'` | 新格子，不顶掉官方「模型（10）」与模块三「Limbs 配置（18）」 |
| 菜单位置 | `order: 11` | 紧挨官方模型页，进入设置第一屏可见 |
| 菜单名 | `label: () => '模型管理'` | 全中文，不随浏览器语言变英文 |
| 保存接口 | `GET/PUT /limbs/model-settings` | Host 半侧注册的窄接口，只能读写推理档位这一个字段 |
| 页面样式 | `lib/client.js` 的 `CSS`（`<style id="dsh-limbs-styles">`） | 与模块一/三同一份主题令牌，卸载即清理 |

模块二没有改模块一的注册参数、优先级或选择逻辑。唯一的跨模块写入是：模型座位打开后把「最近模型名 + 是否声明 max 档」写进独立键 `dsh-limbs:last-model`；写入失败静默。

## 三、档位配置结构

> ⚠️ 本节描述的 UI 渲染已不存在（滑杆已删）。`levels.js` 现在只保留推理档位表，`CONTEXT_LEVELS` 已删。

单一真源在 `lib/model-management/levels.js`：

```js
export const REASONING_LEVELS = [
  { id: 'off', label: '关闭', shortLabel: '关闭', description: '…' },
  { id: 'provider-default', label: '服务商默认', shortLabel: '默认',
    fullDescription: '服务商默认：使用服务商提供的默认强度', isDefault: true },
  { id: 'low', label: '低', shortLabel: '低', … },
  { id: 'medium', label: '中', shortLabel: '中', … },
  { id: 'high', label: '高', shortLabel: '高', … },
  { id: 'max', label: '最高', shortLabel: '最高', … },
]
```

增删档位只改数组；页面按数组渲染，不写死 5 档或 6 档。最高档额外受两个开关约束：

| 开关 | 位置 | 行为 |
|---|---|---|
| `showMax` | `localStorage['dsh-limbs:level-config'] = {"showMax": false}`（缺省展示） | false 时档位表里不出现「最高」 |
| `maxSupported` | 模块一写入的最近模型能力；没有记录按 false | false 时「最高」带 `disabledReason: 当前服务商不支持最高档` |

Client 内置一份同构档位表用于 Host 缺席时降级；测试会逐项比对两份数据，防止漂移。

## 四、旧配置映射

| 旧值 | 新档位 | 备注 |
|---|---|---|
| `off` / `none` / `no` / `false` / `0` / `关闭` / `不启用` | `off` | 关闭 |
| `default` / `provider-default` / `auto` / `inherit` / `null` / 空串 / `默认` / `服务商默认` | `provider-default` | 默认 |
| `low` / `min` / `minimal` / `低` | `low` | |
| `medium` / `mid` / `normal` / `balanced` / `中` | `medium` | |
| `high` / `高` | `high` | |
| `max` / `maximum` / `highest` / `xhigh` / `最高` | `max` | 服务商不支持时回退默认档 |
| 其它无法识别的值 | 默认档 | 记录迁移日志，并 Toast 提示 |

> 历史：`300000` / `600000` / `1M` / `128K` / `512K` 等上下文档位映射已随 `CONTEXT_LEVELS` 一起删除（2026-11-26）。

兼容旧字段名：推理 `reasoning` / `effort` / `reasoningEffort` / `reasoningLevel`。旧数据里的 `context` 字段会被忽略（读时不再迁移）。

迁移日志写入 `localStorage['dsh-limbs:model-migration-log']`（最多保留 20 条），同时 `console.info` 一条中文记录。

## 五、保存、同步与回滚

### 5.1 协议

`GET /limbs/model-settings`

```json
{
  "ok": true,
  "account": "current",
  "settings": { "reasoning": "provider-default", "updatedAt": 1763000000000 },
  "revision": 3,
  "levels": { "reasoning": [], "defaults": {}, "showMax": true },
  "defaults": { "reasoning": "provider-default" }
}
```

`PUT /limbs/model-settings`

```json
{
  "settings": { "reasoning": "high", "updatedAt": 1763000000001 },
  "baseRevision": 3
}
```

- 成功：200，返回已保存设置与新 `revision`。
- 服务端记录时间更新：409 `{ code: "conflict", settings, revision }`。
- 服务端按 `updatedAt` 最新优先；同值或客户端更新时写入，服务端时间取 `max(客户端时间, Host 当前时间)`。
- 数据按账号分桶，账号来自 Host 的 `deepseekAccount.getDeviceIdentity().userId`；未登录落 `local` 桶。
- 落盘：`<DSH_HOME>/dsh-limbs/model-settings.json`，临时文件 + rename 原子写，同文件串行队列。
- 访问令牌：Host 启动时随机生成，通过 index 注入 `window.__DSH_LIMBS_BRIDGE__`；请求必须带 `x-limbs-token`，跨站 `Origin` 拒绝。

### 5.2 前端策略

1. 用户切档 → 同步乐观更新 UI（`status: saving`）。
2. 有 Host 接口 → PUT；成功更新本地缓存、`lastSaved`、`revision`。
3. 失败 → 回滚到 `lastSaved`，Toast「保存失败，已恢复原设置」。
4. 409 且服务端时间更新 → 采用服务端设置，Toast「设置已在其他设备更新，已同步最新设置」。
5. 409 但本地时间更新 → 用服务端 `revision` 重试一次。
6. 每 30 秒 + 窗口 focus 拉一次；服务端更新时静默采用并提示。
7. Host 接口缺席或首次读取失败 → 本机 `localStorage` 模式，状态写「已保存到本机」，不假装同步。

## 六、交互与可访问性

> ⚠️ 本节描述的滑杆交互（拖动吸附 / 点刻度 / Tab + 方向键 / Focus Ring / aria slider）**已整块删除**（2026-11-26）。现在页面是只读的：当前模型名 + 推理摘要 + 「恢复默认」。

- 顶部状态区：当前模型名 + 推理摘要；推理关闭时明确显示「推理已关闭」；服务商默认时显示完整继承说明。
- 恢复默认：底部按钮 → `alertdialog` 二次确认 → 只写回 `reasoning`，当前模型名不变；失败回滚并 Toast。
- 推理档位的真实切换在输入框模型选择器底部的 chips（提供方默认 / Off / Low / High / Max），它真进 provider 的 `effort`。

## 七、离线测试

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH 可执行文件>' .dev\model-management-test.mjs
```

覆盖：档位顺序/最高档开关/禁用原因、旧配置映射表、Host 接口（账号分桶、409、最新时间优先、令牌、跨站、坏值、磁盘旧格式迁移、路由与令牌注入）、Client 仓库（迁移、本地保存、失败回滚、冲突采用、失效档回退）、页面（**已无滑动条**、二次确认、中文残留）。

当前结果：**74 passed, 0 failed**（删滑杆前是 101 条）。

## 八、待确认项

1. **真正跨设备同步**：当前 Host 文件是单机服务端持久化，同一 Host 的多窗口/多标签可同步；跨设备需要 DSH 账号后端接口，本插件没有这个通道。若要接，替换 `mmBridgeRequest` 的 transport 即可，UI 与冲突逻辑无需改。
2. **当前模型选择仍是只读**：设置分区没有 session，无法用 `ctx.modelDirectories` 直接切换模型；页面展示模块一记住的最近模型名，切换仍在 composer 选择器。恢复默认按需求不改变模型。
3. **最高档能力判断**：来自模块一读取的模型 `reasoning.efforts` 是否声明 `max`。如果服务商用了别的 id 表示最高档，需要补一个能力映射。
4. **上下文档位已删**：不再有 `contextAvailable` 入口；上下文挡位是假控件（从未进模型请求），**不做**，见 PRD §5。
5. **Host 重启**：`lib/host.js` 的保存路由与令牌注入需要重启 DSH 才生效；仅刷新页面只会更新 Client。
