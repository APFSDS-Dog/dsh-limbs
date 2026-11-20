# 模块二 · 档位化交互与模型管理 · 交接

> 最后更新：2026-11-17 20:20（Asia/Hong_Kong）
> 范围：只讲 `dsh-limbs` 的**模块二**。模块一（composer 模型座位）、模块三（复盘分析器 / 设置壳子）见 `PROJECT_PROGRESS.md`。
> 状态：**代码完成、离线与浏览器预览验证通过**；`lib/host.js` 的保存接口需要重启 DSH 后做一次真机确认。

---

## 一、一句话定位

把模型管理做成一个全中文、单页、从左到右的档位面板：

- 推理挡位：关闭 → 服务商默认 → 低 → 中 → 高 → 最高（可选）
- 上下文长度：300K → 600K（默认）→ 1M

保存走「即时保存 + 乐观更新 + 失败回滚 + 按账号分桶 + 时间戳最新优先」。

---

## 二、接入面（已按本机运行态核对）

| 区域 | 接入点 | 值 |
|---|---|---|
| 设置分区 | `settings.section`（list） | `id: 'limbs-model'`、`order: 11`、`label: () => '模型管理'` |
| 页面组件 | 同上 | `makeModelManagementSection(ctx)` |
| 保存接口 | Host Web 路由 | `GET/PUT /limbs/model-settings` |
| 令牌注入 | `webServer.tapIndex` | 注入 `window.__DSH_LIMBS_BRIDGE__ = { version, path, token }` |

为什么是 `order: 11`：官方「模型」是 10，模块三「Limbs 配置」是 18；11 让「模型管理」紧挨官方模型页，不抢模块三的格子。

为什么用新 id：`id` 是设置页的格子钥匙。复用官方 id 会把官方页顶掉；新 id 才是加一格。

---

## 三、代码结构

| 文件 | 内容 |
|---|---|
| `lib/model-management/levels.js` | 档位单一真源、默认档、最高档开关、旧配置映射、回退/跳过禁用档、aria 文案 |
| `lib/client.js` | `LevelSlider`、模型管理页、Toast、二次确认、保存仓库、页面 CSS/图标、`settings.section` 注册 |
| `lib/host.js` | 保存接口、账号解析、原子落盘、令牌/同源校验、Node HTTP 适配 |
| `.dev/model-management-test.mjs` | 模块二离线测试，101 条断言 |
| `docs/MODULE2.md` | 设计、协议、映射表、待确认项 |
| `README.md` / `docs/DETAIL.md` / `PROJECT_PROGRESS.md` | 说明与进度 |

模块二**没有**改模块一的模型选择逻辑，也**没有**改模块三的设置页与复盘面板。模块一对模块二的唯一贡献是：打开模型座位时把「最近模型名 + 是否声明 `max` 档」写入 `dsh-limbs:last-model`，供最高档置灰判断；写入失败静默。

---

## 四、档位配置

推理：

```js
[
  { id: 'off', label: '关闭', shortLabel: '关闭' },
  { id: 'provider-default', label: '服务商默认', shortLabel: '默认', isDefault: true },
  { id: 'low', label: '低', shortLabel: '低' },
  { id: 'medium', label: '中', shortLabel: '中' },
  { id: 'high', label: '高', shortLabel: '高' },
  { id: 'max', label: '最高', shortLabel: '最高' },
]
```

上下文：

```js
[
  { id: '300k', label: '300K', statusLabel: '精简' },
  { id: '600k', label: '600K', statusLabel: '适中', isDefault: true },
  { id: '1m', label: '1M', statusLabel: '充足' },
]
```

增删档位只改 `levels.js` 数组；Client 侧有一份同构内置表用于 Host 缺席时降级，`.dev/model-management-test.mjs` 会逐项比对两份数据，防止漂移。

### 最高档

| 开关 | 位置 | 行为 |
|---|---|---|
| `showMax` | `localStorage['dsh-limbs:level-config'] = {"showMax": false}`（缺省展示） | false 时整个最高档不展示 |
| `maxSupported` | 模块一写入的最近模型能力 | false 时最高档圆点置灰，点击提示「当前服务商不支持最高档」 |

### 旧配置映射

| 旧值 | 新档位 |
|---|---|
| `off` / `none` / `no` / `false` / `0` / `关闭` / `不启用` | `off` |
| `default` / `provider-default` / `auto` / `inherit` / `null` / 空串 / `默认` / `服务商默认` | `provider-default` |
| `low` / `min` / `minimal` / `低` | `low` |
| `medium` / `mid` / `normal` / `balanced` / `中` | `medium` |
| `high` / `高` | `high` |
| `max` / `maximum` / `highest` / `xhigh` / `最高` | `max`（不支持时置灰并回退默认） |
| `300000` / `300K` | `300k` |
| `600000` / `600K` | `600k` |
| `1000000` / `1000K` / `1M` | `1m` |
| `128K` / `256K` / `131072` / `256000` 等 | `300k` |
| `512K` / `524288` | `600k` |
| 其它无法识别的值 | 默认档，记录迁移日志并提示 |

兼容字段名：`reasoning` / `effort` / `reasoningEffort` / `reasoningLevel`；`context` / `contextLength` / `contextWindow` / `contextSize`。

迁移日志：`localStorage['dsh-limbs:model-migration-log']`（最多 20 条），另有 `console.info` 中文记录。

---

## 五、保存接口协议

### GET

```json
{
  "ok": true,
  "account": "current",
  "settings": { "reasoning": "provider-default", "context": "600k", "updatedAt": 1763000000000 },
  "revision": 3,
  "levels": { "reasoning": [], "context": [], "defaults": {}, "showMax": true },
  "defaults": { "reasoning": "provider-default", "context": "600k" }
}
```

### PUT

```json
{
  "settings": { "reasoning": "high", "context": "1m", "updatedAt": 1763000000001 },
  "baseRevision": 3
}
```

- 成功 200；服务端时间更新则 409 `{ code: "conflict", settings, revision }`。
- 服务端按 `updatedAt` 最新优先；写入时间取 `max(客户端时间, Host 当前时间)`。
- 账号来自 Host `deepseekAccount.getDeviceIdentity().userId`；未登录落 `local` 桶。
- 落盘：`<DSH_HOME>/dsh-limbs/model-settings.json`，临时文件 + rename，同文件串行队列。
- 请求必须带 `x-limbs-token`；跨站 `Origin` 拒绝。
- Host 接口缺席或首次读取失败：Client 明确降级为「已保存到本机」。

前端策略：乐观更新 → PUT → 成功更新 `lastSaved`/`revision`；失败回滚并 Toast「保存失败，已恢复原设置」；409 服务端较新则采用并提示「设置已在其他设备更新，已同步最新设置」；本地较新则带服务端 revision 重试一次。每 30 秒 + 窗口 focus 拉一次。

---

## 六、交互与可访问性

- 拖动按轨道比例吸附最近**可用**档，松手才提交。
- 点击刻度直接跳转；禁用刻度只提示中文原因。
- Tab 聚焦轨道，显示 2px Focus Ring。
- `←/→`、`↑/↓`、`Home/End` 切换，方向键跳过禁用档。
- `role="slider"` + `aria-valuemin/max/now` + 中文 `aria-valuetext`（示例：推理挡位：中，第 4 档，共 6 档）。
- 当前档：实心圆点 + `✓` + 加粗文字；默认档：文字「默认」；禁用档：仅圆点置灰 + `aria-disabled` + `title` 原因。颜色不是唯一信号。
- 过渡 180ms，`prefers-reduced-motion: reduce` 下关闭。
- 顶部状态区：当前模型名、推理摘要、上下文摘要；关闭时显示「推理已关闭」；服务商默认显示完整继承说明。
- 恢复默认：底部按钮 → `alertdialog` 二次确认 → 只改 `reasoning` / `context`，当前模型名不变。

---

## 七、验证

### 已通过（离线）

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\model-management-test.mjs
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\ui-shell-test.mjs
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\postmortem-test.mjs
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' tools\render-check.mjs
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\open-settings-test.mjs
```

结果：模块二 **101 passed / 0 failed**；模块三 UI 48、复盘 70；选择器回归与设置跳转全过。

### 浏览器预览

预览页：`.dev/module2-preview.html`（`file:///D:/Projects/dsh-limbs/.dev/module2-preview.html`）。
证据图：`shots/module2-page.png`、`shots/module2-focus.png`。

已实测：

- 1024px 视口内容区 640px 居中；480px 视口内容区 417px，最小宽度 400 生效；无横向溢出。
- 六档/三档刻度文字无重叠。
- Tab 聚焦计算样式为 `rgb(79,140,255) 0px 0px 0px 2px`。
- `ArrowRight` 从「服务商默认」切到「低」，`aria-valuetext` 同步。
- 点击「关闭」顶部显示「推理已关闭」。
- 点击禁用「最高」提示「当前服务商不支持最高档」。

### 未通过 / 未做（需要真机）

- **Host 重启确认**：`lib/host.js` 的路由与令牌注入刷新页面不会加载，必须重启 DSH。
- 真实多窗口同步：逻辑与 HTTP 适配器已测，真机两窗口未跑。
- 真实拖动手势：代码与指针逻辑在，桌面窗口未做手势验证。
- 上下文某档真实不可用：`contextAvailable` 配置入口已留，尚未接服务商/模型能力源。

---

## 八、踩坑与注意

1. **Host 改动刷新无效**：`lib/host.js` 必须重启 DSH；只刷新页面只更新 Client。
2. **不要复用官方 settings id**：会顶掉官方「模型」页；模块二用 `limbs-model`。
3. **不要禁用官方 `dsh-client-ui-model-selection`**：`ctx.modelDirectories` 与 `/model` 都靠它，模块一和模块二都需要它活着。
4. **CSS 里不要写反引号**：`CSS` 是模板字符串，注释中的反引号会截断整段 CSS；`.dev/model-management-test.mjs` 有源码卫生检查。
5. **首次升级要推本机迁移结果**：Host 还没记录（`updatedAt = 0`）而本机已有非默认设置时，Client 会先 PUT 本机值，不能被服务端默认值覆盖。
6. **令牌不要回显**：`window.__DSH_LIMBS_BRIDGE__` 里有令牌，不要写进日志/文档/截图。
7. **账号解析失败不要阻塞**：Host 读不到账号就落 `local` 桶，仍可保存。
8. **恢复默认只改两个字段**：不要把模型选择塞进默认值。

---

## 九、待确认项

1. **真正跨设备同步**：当前是单 Host 文件持久化；跨设备需要 DSH 账号后端接口。替换 `mmBridgeRequest` 的 transport 即可，UI/冲突逻辑不用改。
2. **当前模型选择仍只读**：设置分区没有 session，模型仍在 composer 选择器里切换。
3. **最高档能力判断**：按 `reasoning.efforts` 是否包含 `id === 'max'`；如果服务商用别的 id，需要补映射。
4. **最高档展示开关**：目前是 `localStorage` 配置项，没有做成页面上的用户开关。
5. **上下文档位可用性**：`buildLevels({ contextAvailable })` 已留入口，未接真实能力源。

---

## 十、交接后第一件事

1. 重启 DSH。
2. 打开 设置 →「模型管理」，确认入口在官方「模型」旁边。
3. 改一次推理/上下文 → 刷新 → 设置保留；检查 `<DSH_HOME>/dsh-limbs/model-settings.json`。
4. 跑一遍 §7 的五条测试命令。
5. 若入口没出现：先确认 `package.json` 的 `files` 含 `lib/model-management`，再确认 profile 是 `link:` 安装、刷新/重启。

**未提交、未推送**：按约定只改文件，提交与推送由阿昆决定。`package.json` 版本仍为 `0.1.0`，发版前再抬版本。
