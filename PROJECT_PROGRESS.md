# 项目进度 · dsh-limbs

> 最后更新：2026-11-14 17:40
> 规则：**只追加，不重写历史**。每次任务收尾更新一次，切换 Agent（WorkBuddy ↔ DSH）前扫一眼。
> 这个文件是「干到哪了」的唯一真源——比聊天记录可靠。

---

## 1. 当前状态

一句话：**能跑。** 设置跳转的 bug 已修完，离线 30 项断言 + 真机验证全部通过；代码在 worktree 里，**没有提交**（不是 git 仓库）。

---

## 2. 正在做

- [ ] 无进行中任务。上一轮（设置面板快捷入口）已收尾。

---

## 3. 已完成（最近 10 条，倒序）

- 2026-11-14 · 修「配置」按钮点了没反应（打开设置 → 模型分区）· `lib/client.js` L241–338
- 2026-11-14 · 新增离线测试 `.dev/open-settings-test.mjs`（6 组场景 / 16 断言，全 PASS）
- 2026-11-14 · `tools/reload-window.ps1` 改为枚举窗口取句柄（原版依赖 `MainWindowHandle`，本机返回 0，必然失败）
- 2026-11-14 · 新增 `tools/state.ps1`（几何 + UIA + 截图同一进程，避免三份状态对不上）
- 2026-11-14 · 新增 `tools/chain.ps1`（同一进程内串行点击；含前台校验，见坑 #3）
- 2026-11-14 · `tools/capture-window.ps1` 改屏幕拷贝（`PrintWindow` 对 WebView2 只返回可见条带）
- 2026-11-14 · `tools/uia.ps1` 窗口标题改包含匹配（标题带会话名）

---

## 4. 下一步

1. **真机回归「配置」跳转**：刷新窗口 → 打开模型选择器 → 点「配置」→ 应直接停在「设置 · 模型」。上一轮已通过，改其它逻辑后值得再跑一次。
2. 若要把「设置入口」做成正式能力（而非 DOM 探测），去查客户端插件有没有官方导航接口；`docs/DETAIL.md` 的「限制」一节现在仍写着「没有管理提供商入口」。
3. 补 `.git`：仓库当前**不是** git 仓库，没有历史可比、也没有 diff 可 review。要长期迭代建议先 `git init`。

---

## 5. 关键决策

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-11-14 | 设置跳转继续用 DOM 探测，不改官方 asar | 客户端插件没有打开设置页的公开接口；改 asar 属于改发行包，升级即丢。探测失败时静默 no-op，不影响选择器本身 |
| 2026-11-14 | 同时兼容两种入口布局（dialog 按钮 / 账号菜单项） | 这个 DSH 构建把 `settings.launcher` 让给了账号行，独立设置按钮不存在；只认一种就会在另一种布局下静默失效 |
| 2026-11-14 | 点击前强制校验 DSH 是前台窗口 | 曾把模拟点击落到 Photoshop 里（见坑 #3）。宁可报错也不误伤别的程序 |
| 2026-11-14 | `LIMBS_META` 保持留空 | 官方目录没有价格/倍率/负载字段，没有可指认来源的数字就不填（沿用既有决策） |

---

## 6. 踩过的坑

**#1 · 「配置」点了没反应**
现象：点底栏「配置」毫无反应，设置面板不弹。
根因：代码只找 `aria-haspopup="dialog"` 且 `aria-label` 含「设置」的按钮。本构建里那按钮不存在——`settings.launcher` 被账号行占了，设置是账号菜单（`aria-label="账号菜单"` + `aria-haspopup="menu"`）里的一行「设置」。
绕法：两种布局都试；先试 dialog 按钮，找不到就点账号菜单再点「设置」。

**#2 · 面板弹了但停在「账号与余额」**
现象：能打开面板，但不是「模型」页。
根因两个叠加：① 面板刚挂载时导航按钮还没渲染，代码立刻返回，后续不再重试；② 菜单项文字带快捷键后缀，`label === '设置'` 精确比较命中不了；而放宽成 `startsWith` 又会把**菜单容器**（文字以「设置」开头）算进去，点了等于点空。
绕法：轮询到导航按钮出现再点；菜单项只匹配可点击元素（`button` / `[role="menuitem"]` / `[role="button"]` / `a`），且只容忍短快捷键尾巴（见 `labelIsRow`，`lib/client.js` L284）。

**#3 · 模拟点击落进了 Photoshop**（重要）
现象：点完 DSH 界面没反应，截图拍到的是 Photoshop。
根因：`SetForegroundWindow` 在 Windows 上并不总能成功把窗口提到前台；`mouse_event` 是真实系统级输入，点到**当前最上层窗口**。DSH 被别的程序挡住时，点击就落进别的程序。
绕法：`tools/chain.ps1` 点击前调 `IsForegroundOf($hwnd)`，不是前台就报错退出（exit 2），绝不盲点。**任何模拟点击脚本都应该带这道闸。**

**#4 · 截图与 UIA 状态对不上**
现象：UIA 报按钮在 y=833，截图里却在 y=530。
根因：`PrintWindow` 对 WebView2 只返回可见条带（窗口 1400px 高，图 903px），坐标基准被打乱。
绕法：改用 `GetClientRect` + `ClientToScreen` + `CopyFromScreen`，并在同一进程内一次取完几何/UIA/截图（`tools/state.ps1`）。

**#5 · 窗口标题带会话名**
现象：按标题 `DeepSeek Harness` 精确匹配找不到窗口（实际标题是「继续设置面板快捷入口任务 — DeepSeek Harness」）。
绕法：改为包含匹配。另注：本机主进程 `MainWindowHandle` 返回 **0**，必须 `EnumWindows` 找句柄。

**#6 · `pwsh -File` 的数组参数会被空格拆坏**
现象：`-Steps 'a','b c'` 被当成一整串。
绕法：改成单个字符串 + `;;` 分隔。

---

## 7. 交接备注

**环境事实**

- DSH 桌面版：`D:\Apps\DeepSeekHarness\DeepSeek Harness.exe`，数据目录 `D:\Apps\DSHData`，profile `desktop`
- 本机没有 `node` / `pnpm` 在 PATH 上。跑 mjs 脚本用：`$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' <script.mjs>`（Electron 当 Node 使，v24.21.0）
- 插件以 `link:` 装进 profile，改 `lib/client.js` 后**必须刷新窗口**才生效

**怎么验证**

```pwsh
# 离线：结构 + 设置跳转（16 + 14 断言，应全 PASS）
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\open-settings-test.mjs
& 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' tools\render-check.mjs

# 真机：刷新 → 打开选择器 → 点配置
pwsh -File tools\reload-window.ps1 -WaitMs 10000
pwsh -File tools\chain.ps1 -Steps '^DeepSeek V4\.1 Flash;;^配置$' -WaitMs 3000 -Dump dialog -Shot 'D:\Projects\dsh-limbs\shots\x.png'
```

**临时文件**

- `shots/` 与 `.dev/` 都在 `.gitignore` 里，不随包发布；`shots/` 里目前留了 `menu-open.png`、`r2.png` 两张证据图
- `.dev/asar-*.mjs` 是只读排查 app.asar 的临时脚本（grep / 打印上下文），**只读，不改官方文件**

**别碰的东西**

- 不要去改 `app.asar` 里的任何官方文件；排查只读，够用
- 不要禁用 `@deepseek-ai/dsh-client-ui-model-selection`：`ctx.modelDirectories` 和 `/model` 命令都由它提供
- 账号行占着 `settings.launcher`，若要换视觉效果，注意别把账号入口顶掉

**未提交、未推送**：按约定只改文件，`git init` / commit / push 由阿昆决定。

**这次的一处悬案**：阿昆提到「给设置面板增加 `data-shortcut-modal="settings"`」「修改底部导航结构」，但本仓库里查不到对应改动（该标记由官方 shell 写入，插件只读）。若相关改动在其他工程，需要他指明路径。
