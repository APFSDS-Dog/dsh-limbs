# 模块三 · UI 框架（前端壳子）· 交接

> 最后更新：2026-11-17 02:15（Asia/Hong_Kong）
> 范围：只讲 `dsh-limbs` 的**前端 UI 壳子**——设置选项卡 + 复盘面板，当前全部跑 **Mock 数据**。
> 相关文档：`MODULE3-HANDOFF.md`（复盘分析器 Host 侧）、`PROJECT_PROGRESS.md`（全局进度真源）。
> 状态：**真机跑通**。两个区域都在 DSH 桌面窗口里目视确认过；48 条离线断言全过。

---

## 一、一句话定位

先搭壳子、不接业务：让「设置页长什么样」「复盘面板长什么样」在真机上先立住，模块三的宿主分析器接上来时只换数据源、不动布局。

现在面板里的报告是硬编码假 Markdown，按钮只 `console.log('触发复盘')`。

---

## 二、注册了什么（API 均为本机运行态核对，非文档推断）

| 区域 | Slot / 服务 | 作用域 | 关键参数 |
|---|---|---|---|
| 设置选项卡 | `settings.section`（list） | root | `id: 'limbs'`、`order: 18`、`label` 用 thunk |
| 面板类型 | `ctx.sidebarRightTabs.register` | — | `id`/`kind` = `dsh-limbs` / `limbs-review`、`priority: 'extension'` |
| 面板 body | `sidebar.right.pane.tab`（keyed） | session | `key: 'dsh-limbs'` |
| 面板标题 | `sidebar.right.pane.tab.title`（keyed） | session | `key: 'dsh-limbs'` |
| 呼出入口 | `conversation.session.header.utilities`（list） | session | `id: 'limbs-review'`、`order: 28` |

代码位置：`lib/client.js` L1238–L1306（`apply()` 尾部）。

### 2.1 为什么 `id` 必须用自己的

`id` 是「格子的钥匙」：**用新 id 才是加一格，复用官方 id 会把官方那一页顶掉**。
官方当前已占：`account(-10) general(0) models(10) commandcode(12) plugins(15) agent-presets(20) cost-meter(30)`。
`limbs` 与它们都不冲突，`order: 18` 落在「内置插件 15」和「Agent 预设 20」之间。

### 2.2 为什么面板走「右栏 Tab」而不是悬浮球

DSH 官方自己的 plan / schedule / deliverables 全走这条两段式路径：

```
第一段  ctx.sidebarRightTabs.register({ id, kind, title, guide })   ← 这个类型"是什么"
第二段  slots.register({ name: 'sidebar.right.pane.tab', key: id })  ← 这个类型"画什么"
```

好处：可停靠可浮动、不遮挡对话、标题栏可关闭、刷新后布局自动恢复、还能在「指南」页拿到一张入口卡。
`shell.overlay`（悬浮球路线）要自己处理遮挡、焦点、Esc，文档也建议仅在确需 overlay 时才用。

面板类型是**页类型**，所以**不设 `patterns`**——它是按 `kind` 打开的，不认资源地址。

### 2.3 `inject` 数组（漏了会静默跳过）

```js
const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']   // L1167
```

两个新服务都用 `ctx.get()` + 存在性判断，取不到就整体跳过、不抛错。这是刻意设计：**别的 profile 没装右栏时不至于让选择器连带失效**。

---

## 三、代码结构（`lib/client.js`，1310 行）

| 区块 | 行号 | 内容 |
|---|---|---|
| 文案字典 `STR` | L58–L165 | 新增 `settings*` / `review*` / `effort*` 词条，中英双份 |
| 样式 `CSS` | L185–L306 | 新增 `.limbs-page*` / `.limbs-row2` / `.limbs-select` / `.limbs-switch*` / `.limbs-panel*` / `.limbs-run*` / `.limbs-report*` / `.limbs-md` / `.limbs-headerBtn` |
| 设置存储 | L955–L1001 | `localStorage` + `useSyncExternalStore` + `effortLabel` |
| 设置页组件 | L1003–L1056 | `SettingsRow`(L1004) / `LimbsSwitch`(L1015) / `LimbsSettingsSection`(L1026) |
| 面板组件 | L1058–L1164 | `LimbsReviewPanel`(L1093) / `LimbsReviewTitle`(L1149) / `LimbsReviewHeaderButton`(L1154) + 两个占位常量 |
| 注册 | L1238–L1306 | 四组 slot + 一个 tab 类型 + `openTab` 闭包 |

三个占位常量（接真数据时全删）：

- `MOCK_PANEL_MODELS`（L1066）— 面板顶部下拉的 3 条假模型
- `MOCK_REPORT`（L1072）— 报告区的假 Markdown（含表格）
- `CONTEXT_CHOICES` / `EFFORT_CHOICES`（L961–L962）— 设置页两个下拉的选项

### 3.1 设置值为什么存 localStorage 而不是 Host Config

**故意的。** Host Config 的 schema 现在不存在，硬写进去等于宣称一个假契约——用户在设置里改了个值，界面说"已保存"，实际什么都不影响，比明摆着标"占位"更糟。

所以：页面顶部有一句 `settingsMock` 文案明说"只存在本机浏览器里"，值落 `localStorage['dsh-limbs:settings']`，读取时校验枚举、非法值回落到默认。

### 3.2 「一键复盘」的占位实现

```js
const runReview = () => {
  console.log('触发复盘')        // ← 就这一行是"业务"
  setRunning(true)
  // 240ms 后回落，并显示"占位触发"提示
}
```

计时器存在 `useRef` 里，标签页卸载时清掉——避免在已卸载组件上 `setState`。

---

## 四、踩过的两个真坑（都是这次现场抓到的）

### 坑 1 · 残留 `<style>` 让热重载永远显示旧 CSS

注入代码原本写的是：

```js
if (document.getElementById(CSS_ID) === null) { /* 才插入 */ }
```

**热重载换掉了模块，但上一轮追加的 `<style>` 还在页面里。** 新代码看到 id 已存在就跳过 → 新 CSS 一次都没装上。
症状极具迷惑性：连着三次改配色，界面像素级完全不变，看起来像"改错了"，实际是被这行判断吞了。

现在：先 `remove()` 同 id 旧元素，再**无条件**写入当前 CSS 文本。`ctx.effect` 的 cleanup 仍负责卸载，禁用插件不留残渣。

```js
ctx.effect(() => {
  const previous = document.getElementById(CSS_ID)
  if (previous !== null) previous.remove()
  const element = document.createElement('style')
  element.id = CSS_ID
  element.textContent = CSS
  document.head.appendChild(element)
  return () => { document.getElementById(CSS_ID)?.remove() }
}, 'dsh-limbs: styles')
```

### 坑 2 · CSS 注释里的反引号截断了模板字符串（我自己写出来的）

`const CSS = ` + 反引号 是一个大模板字符串。我在注释里写了一个带反引号的路径，字符串提前结束 → **整个插件解析失败、界面全无**。

最坑的是：`node --check lib/client.js` 照样 **exit 0**，查不出来。

现在注释里不写反引号；并且 `.dev/ui-shell-test.mjs` 加了「源码卫生」段（L152 起）当场拦：

- CSS 体长度 > 2000（被截断会明显变短）
- 体内反引号数量 = 0
- 关键选择器（`.limbs-switchKnob` / `.limbs-select` / `.limbs-panel` / `.limbs-run` / `.limbs-md`）都在

---

## 五、配色：别猜，查 token

本机主题 token 真实取值（源头 `ui-theme/lib/client.js`）：

| token | light | dark |
|---|---|---|
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-bg-base` | `#ffffff` | `#151517` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-brand-primary` | 亮色系 | **近白** |

由此定下的两条硬规矩：

**1. 主按钮不能用 `brand-primary` 打底配白字。** 深色主题下 `brand-primary` 本身就是近白 → 白底白字，彻底看不见。改用 `label-primary` 打底 + `bg-base` 文字（这对 token 在两种主题下正好互为反色）。

**2. 开关靠同一条规则。** 圆钮永远取与轨道**相反**的那一个：

- 关：`label-primary` 圆钮 压在 `label-primary @34%` 轨道上
- 开：`bg-base` 圆钮 压在 `label-primary` 满强度轨道上

这条是**按截图像素反解验证的**，不是肉眼调：轨道实测 `62,62,63`（对得上 12% 白叠底）、圆钮 `21,21,23`（对得上 dark 的 `bg-base`）。

> 教训：一开始用 `bg-base` 当圆钮 + `border-l2` 当轨道，深色主题下**深圆钮压深轨道**，两态都糊成一片。凡拿不准就先量像素。

---

## 六、验证

### 6.1 离线（48 条断言，全过）

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\ui-shell-test.mjs
```

`.dev/ui-shell-test.mjs`（320 行）自带一个迷你 React（只实现 `createElement` + 六个 hook），因为 `lib/client.js` 在自己的工厂里就解构了 hooks，外部 patch `React` 已经太晚。这样能真正拿到 `onClick` 并触发。

覆盖：源码卫生 → 五个注册面的 id/order/key → 设置页两个下拉的选项与落盘 → 开关 `aria-checked` 翻转与持久化 → 面板按钮文案/点击日志/运行态/回落提示 → 标题行入口调 `openTab` → 标签页标题文案。

### 6.2 选择器回归（14 条，全过）

```pwsh
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' tools\render-check.mjs
```

> 注意：`tools/render-check.mjs` 原来只保留「最后一次注册」，新增注册后失效了。已改成按 slot 名收集、再取 `conversation.input.model`。

### 6.3 真机

```pwsh
pwsh -File tools\chain.ps1 -Steps '^账号菜单$' -WaitMs 1300 -Dump none
pwsh -File tools\chain.ps1 -Steps '^设置' -WaitMs 1800 -Dump none
pwsh -File tools\chain.ps1 -Steps '^Limbs 配置$' -WaitMs 1600 -Dump none -Shot shots\settings.png
pwsh -File tools\chain.ps1 -Steps '^复盘$' -WaitMs 1600 -Dump none -Shot shots\panel.png
```

- 设置：导航里出现「Limbs 配置」，位置在「内置插件」与「Agent 预设」之间 ✔
- 面板：标签页「Limbs 复盘」、下拉、按钮「一键复盘」、假 Markdown 报告 ✔
- 开关两态（`shots/final-settings.png` 关 / `shots/final-switch-on2.png` 开）都清晰 ✔

**`tools/chain.ps1` 的前台校验是有用的，别绕过。** 这次它拦住过一次误点：DSH 不在前台时命令直接 `exit 2`，否则那次点击会落到 Command Code 面板上。它确实拦住了，说明保留是对的。

### 6.4 一个环境限制（不是 bug）

DSH 按 **内容哈希** 缓存插件代码：`/plugins/<pkg>/client.js?rev=<mtime+ctime+size 的 sha1>`，注释明写「带版本号的代码不可变；版本不匹配就拒绝，不会返回新字节」。
所以**改完 `client.js` 后普通 Ctrl+R 拿不到新代码**，热重载通道（unlag）也要先在设置里打开对应开关。本次最终是靠**重启 DSH** 确认的。

浏览器工具（`browser_*`）摸不到 DSH 桌面窗口的 WebView——它连的是独立 Chrome。桌面窗口只能靠 `tools/state.ps1`（UIA + 截图）和 `tools/chain.ps1`（真鼠标点击）。

---

## 七、下一步（接真数据时照这个删/改）

1. **设置项改走 Host Config**：先给 `lib/host.js` 声明 Config schema，再把 `readSettings/updateSettings` 换成读写它；`CONTEXT_CHOICES` / `EFFORT_CHOICES` 换成真实枚举。
2. **面板模型下拉改读真目录**：用 `ctx.modelDirectories.directoryFor(sessionId)`（选择器 L1207 已在用这个服务），删掉 `MOCK_PANEL_MODELS`。
3. **「一键复盘」接宿主**：`lib/host.js` 的 `reviewConversation(ctx, agent, topN)` 已经写好了（977 行，工具 `analyze_conversation_efficiency` + `/limbs-review` 命令都在）。注意它需要 `agent`（`{ id }`），面板里要从 slot props 拿 `sessionId`。走 Host 需要 `host.call()` 或 Remote 通道——**这是下一步最大的未知点，先确认通道再动手**。
4. **报告区换 Markdown 渲染**：现在 `<pre>` 原样显示。DSH 自带 Markdown 渲染器在 conversation 包里，插件不能直接 `require`；先查有没有可用槽位或公开服务，没有再自己写轻量渲染。删掉 `MOCK_REPORT` 与「假数据」徽标。
5. 面板打开时应带上当前会话上下文——现在 `openTab(kind)` 没传 `params`，接真数据后需要 `params: { sessionId }`。

---

## 八、相关文件

| 文件 | 说明 |
|---|---|
| `lib/client.js` | 本次改动全部在这里（922 → 1310 行） |
| `lib/host.js` | 模块三分析器（本次**未改动**，等 UI 接上来） |
| `.dev/ui-shell-test.mjs` | 新增，48 条断言，含源码卫生检查 |
| `tools/render-check.mjs` | 已修（改成按 slot 名收集注册） |
| `PROJECT_PROGRESS.md` | 已追加 §9 |
| `shots/final-settings.png` · `final-switch-on2.png` · `final-panel.png` | 真机证据图（`shots/` 在 `.gitignore` 里） |
| `package.json` | 版本仍 `0.1.0`；发版前记得抬版本 |

**未提交、未推送**——按约定只改文件，提交时机由阿昆定。
