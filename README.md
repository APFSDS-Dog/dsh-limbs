# dsh-limbs

> DSH 的「手脚」：模块一把 composer 里那个朴素的模型选择器换成可搜索、双栏、键盘可用的版本；模块二把模型管理收敛成一页只读面板（上下文挡位与档位条滑杆已于 2026-11-26 删除）；模块三在对话结束后复盘 token 到底花在哪儿。模型数据来自 DSH 官方目录与原生事件流，不联网、不自建模型清单。

![MIT](https://img.shields.io/badge/license-MIT-blue)

## 这是什么

DSH（DeepSeek Harness）的模型选择座位 `conversation.input.model` 默认只显示一个简单下拉。**dsh-limbs** 用同一个槽位、`priority: -1` 遮蔽官方控件，替换为一个更完整的抽屉：

- 搜索框：按模型名、模型 id、描述、提供商名/id 过滤，大小写不敏感，命中后跨提供商平铺并标注来源
- 双栏：左侧提供商 tab（带模型计数），右侧该提供商的模型列表；两栏独立滚动
- 键盘操作：`↑` `↓` 循环移动、`Enter` / `Tab` 确认、`Esc` 关闭并回到触发按钮
- 推理档位：选中模型声明了 reasoning 时，底部出现档位胶囊，随时切换
- 状态提示：单提供商加载失败只影响自己那一行，其余照常可用
- 显示层元数据（倍率 / 折扣 / 负载圆点）预留了填写位，默认留空不显示任何数字

它**不**接管官方目录、**不**自带模型清单：切换结果与 `/model` 命令共用同一份 `ctx.modelDirectories`，两边永远显示同一个选择。

## 功能一览

| 区域 | 行为 |
|---|---|
| 触发按钮 | 显示当前模型名与推理档位；忙碌时显示脉冲点 |
| 搜索 | 输入即过滤；`✕` 清空并回到输入框 |
| 左栏 | 「全部提供商」+ 每个提供商（名称 + 模型数），点击即筛选右栏 |
| 右栏 | 行动态分组标题（全部视图下吸顶）；选中行有品牌色底 + `✓` |
| 底栏 | `N 提供商 · M 模型 · K 失败`、「重新读取」、键盘提示 |
| 主题 | 全部颜色走 `--dsw-alias-*` / `--dsw-specific-*` 令牌，浅色/深色自动跟随 |

## 模块二 · 档位化模型管理（2026-11-26 缩水）

设置里的「模型管理」是一个单页、全中文、居中 400–640px 的只读面板：显示当前模型，底部一个「恢复默认」。

**原来的两样已经删掉**，原因写进了 PRD：

| 删掉的 | 为什么 |
|---|---|
| **上下文挡位**（300K / 600K / 1M） | 假控件 —— 代码里从未把 `context` 传给模型请求，存了不生效 |
| **档位条滑杆**（`LevelSlider`） | 与 chips 功能重复，chips 更轻：一眼看全、单击即选 |

**保留**：推理档位 chips（提供方默认 / Off / Low / High / Max），在输入框模型选择器底部，**它真进 provider 的 effort**，位置与交互都没动。

- **保存**：即时保存 + 乐观更新 + 失败回滚；Host 侧按账号分桶、按 `updatedAt` 最新优先，多窗口通过 30 秒轮询和窗口 focus 同步。
- **恢复默认**：二次确认后只恢复推理挡位，当前模型不变。
- **设置项**：`effort`（默认推理强度，下拉）与 `costWarn`（费用超限提示，开关）。

完整设计与协议见 [Docs/MODULE2.md](Docs/MODULE2.md)（仓库内文档，不随包发布）。Host 保存接口 `GET/PUT /limbs/model-settings` 的令牌由 Host 启动时注入页面；`lib/host.js` 改动需要重启 DSH 才生效。

## 模块三 · 事后复盘分析器

对话结束后复盘「钱花在哪儿」，找出浪费模式并给出可执行的优化建议。

两个入口：

| 入口 | 用法 |
|---|---|
| 工具 | `analyze_conversation_efficiency`，模型可自行调用；参数 `top_n` 控制归因榜单长度（默认 3） |
| 命令 | `/limbs-review [top_n]`，直接面向人，不经过模型 |

报告包含：置顶的**最该做的三条**（摘要），以及全文六章 —— 总账、费用大头（Top N 工具归因）、上下文构成、效率诊断、效率评分、优化建议。

> 置顶那一节只是把「优化建议」的前 3 条原样搬到顶部，**不新生成**；第六章的全文照旧保留。报告生成逻辑没变，变的只是顺序。

### 报告落盘：切会话 / 重启都还在

复盘跑完会自动写一份到 `<DSH_HOME>/dsh-limbs/reviews/<sessionId>.md`（Host 侧写盘，受 `sandboxPolicy` 权限档约束：`read-only` 会话不写并明说原因）。面板打开时先读这个文件：有就显示，并在标题旁标 **生成于 <时间>**（时间取自文件的 mtime，正文保持纯报告）。按钮随之变成「重新复盘」，覆盖同一份文件。

**清理策略**（每次写盘后跑一次，实现在 `lib/review-store.js` 的 `pruneReviewReports`）：只保留同时满足两个条件的报告 —— 最近 **20 份**、且 **30 天内**；任一条不满足就从最旧删起。这样数量和时长两个方向都不会永久增长。

### 数据源：投影优先，事件流兜底

- **装了 `dsh-context` 时**，读它已经算好的 `contextTimeline` 投影（走公开接口 `ctx.sessionProjections.snapshot`，不是逆向它的私有实现）：
  美元金额、上下文按类别拆分、每个工具耗时、终端输出字符数。
- **没装、键未注册或版本不匹配时**，自动退回纯事件流口径：从 `tool/call` / `tool/result` / `assistant/message` 自己算。
  功能完整、不报错，只是没有金额与类别构成。

### 费用归因口径

`inputTokens` 是**整段前缀的总量，不是增量**。直接按步累加会重复计费、虚高到没法看。
所以用差分：第 N 步的输入减去第 N−1 步的输入，归给第 N−1 步的工具，按各工具结果体量分摊；输出 token 直接归本步。
缓存命中只展示、不参与排名——没有可指认的折扣价就不编一个。

### 诊断规则

重复调用（同名同参 ≥ 3 次）、全量读大文件（≥ 20KB 且未指定范围）、终端输出过大（≥ 8KB）、
单次结果过大（≥ 30KB）、工具报错。阈值集中在 [lib/host.js](lib/host.js) 的 `THRESHOLDS`，按真实数据调。

## 安装

前置：已安装并能正常使用的 DSH（桌面版或带 Web GUI 的环境），以及你要安装到的 profile 目录（例如 `profiles/desktop`）。

### 方式 A · 插件管理器（推荐）

把本仓库放在任意目录，在 DSH 的插件管理里选择**安装本地 bundle**，指向仓库根目录（含 `package.json` 的那一层）。安装器会做三件事：

1. 在 profile 的 `package.json` 里写入 `"dsh-limbs": "link:<仓库路径>"`；
2. 把 `dsh-limbs` 加进 `dsh.profile.bundles`；
3. 执行安装、生成指向仓库的符号链接（链接安装 = 改源码后刷新即可生效）。

首次安装后如果 composer 里没变化，刷新页面或重启 DSH。

### 方式 B · 手动链接

编辑 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-limbs": "link:D:/Projects/dsh-limbs"   // 换成你的仓库绝对路径，正斜杠
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …其它 bundle…
        "dsh-limbs"
      ]
    }
  }
}
```

然后在 profile 目录执行包管理器安装（生成符号链接），再刷新 / 重启：

```pwsh
pnpm install
```

### 安装后的结构

```
<profile>/
├─ package.json          # link 依赖 + bundles 列表
└─ node_modules/dsh-limbs -> <仓库路径>   # 符号链接
```

`package.json` 里的 `dsh.bundle.patch` 指向 [cordis.patch.yml](cordis.patch.yml)，由它在加载器里插入插件条目；`dsh.client` 声明这是 Web 客户端插件。

## 关闭 · 恢复内置选择器

不需要卸载，停用这一行即可，内置控件立刻回来：

```yaml
# <profile>/cordis.patch.yml
- id: dsh-limbs
  name: dsh-limbs
  disabled: true
```

也可以在插件管理页把这一条关掉。本插件的样式（`<style id="dsh-limbs-styles">`）和事件监听都注册在 `ctx.effect` 上，条目卸载即清理，不留 CSS/DOM 残留。

彻底移除时，把 `dsh.profile.bundles` 里的 `dsh-limbs` 和 `dependencies` 里的那一行一起去掉，再重新安装依赖。

> ⚠️ **不要**去禁用官方的 `@deepseek-ai/dsh-client-ui-model-selection`。`ctx.modelDirectories` 服务和 `/model` 命令都由它提供，禁掉会连带失去目录数据，本插件就无模型可选了。替换靠的是同槽位 `priority: -1`，不是禁用。

## 配置

### 显示层元数据

官方模型目录（`ModelCatalogModel`）只有 `id / name / description / reasoning / badge`，**没有**价格、倍率、实时负载，也没有模型 Logo。这些展示项集中在 [lib/client.js](lib/client.js) 顶部的 `LIMBS_META`，默认全部留空——界面上不出现任何数字，负载圆点统一灰色「未知」，图标用提供商首字母占位块。

有可信数据源后填进去，界面立即生效，不用改结构：

```js
const LIMBS_META = {
  providers: {
    scnet: { mark: 'S' },            // 标志块文字，缺省取提供商名首字母
  },
  models: {
    // 键为 `providerId/modelId`
    'scnet/GLM-5.3-Flash': {
      multiplier: '0.69x',           // 倍率，右列显示
      discount: '夜间折扣',           // 折扣标签，支持 { zh, en }
      status: 'idle',                // idle 绿 / warn 黄 / busy 红 / 缺省灰
    },
  },
}
```

字段说明：

| 字段 | 位置 | 类型 |
|---|---|---|
| `providers[id].mark` | 首字母块 / 行内标志 | `string`（取前 2 字符） |
| `models[key].multiplier` | 行右侧 | `string` |
| `models[key].discount` | 模型名旁标签 | `string` 或 `{ zh, en }` |
| `models[key].status` | 行首圆点 | `'idle' \| 'warn' \| 'busy'` |

> 原则：没有可指认来源的数字就不填。界面宁可空着，也不编造。

### 模块二设置

模块二的推理档位设置由 Host 保存到 `<DSH_HOME>/dsh-limbs/model-settings.json`，按账号分桶（`deepseekAccount.getDeviceIdentity().userId`，未登录用 `local`）。保存接口只接受推理档位这一个字段，带 `x-limbs-token`，并拒绝跨站来源。

想改档位本身，编辑 [lib/model-management/levels.js](lib/model-management/levels.js)（数组即配置）；Client 侧有一份同构内置表用于 Host 缺席时降级，测试会比对两份数据。最高档展示开关：

```js
localStorage['dsh-limbs:level-config'] = JSON.stringify({ showMax: false })
```

其它语言文案仍在 `lib/client.js` 的 `STR`（`zh` / `en` 两套）；模块二为了满足「全中文」要求，使用独立的 `MM` 文案对象，不随浏览器语言切换。

## 主题与样式令牌

插件里的每一个颜色、边框和阴影都取自 DSH 官方设计令牌（`--dsw-*`），没有自造的颜色变量。**任何主题只要覆盖了官方令牌，本插件就自动跟着变**，不需要改插件代码。全部 19 个令牌已对照当前 DSH 版本的主题表逐个核对，均存在。

| 用途 | 令牌 | 浅色 / 深色 |
|---|---|---|
| 弹层实心底 | `--dsw-alias-bg-base` | `#fff` / `rgb(21,21,23)` |
| 弹层色调 | `--dsw-menu-surface-fill` | `rgba(252,253,254,.7)` / `rgba(48,49,54,.64)` |
| 分组吸顶标题 | `--dsw-alias-menu-group-header-fill` | `rgba(248,249,250,.94)` / `rgba(48,49,54,.94)` |
| 弹层阴影 | `--dsw-elevation-panel` | 官方面板投影 |
| 边框 / 分隔线 / 焦点环 | `--dsw-alias-border-l1`、`-l2` | 随主题 |
| 文字层级 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-dimmed` | 随主题 |
| 悬停 / 危险底色 | `--dsw-alias-interactive-bg-hover`、`-hover-danger` | 随主题 |
| 品牌色（高亮、勾选） | `--dsw-alias-brand-primary` | 随主题 |
| 状态点 / 折扣标签 | `--dsw-alias-state-{success,warn,error,idle}-primary`、`-warn-label` | 随主题 |
| 搜索框底色 | `--dsw-alias-bg-layer-2` | 随主题 |

### 为什么弹层是实心的

官方菜单的表面色本身是半透明玻璃（配合 `backdrop-filter: blur(40px)` 使用）。本插件没有模糊层，直接用它就会「透视」底下的对话。所以这里用官方令牌做了一次叠加：

```css
background-color: var(--dsw-alias-bg-base, #fff);
background-image: linear-gradient(var(--dsw-menu-surface-fill, transparent),
                                 var(--dsw-menu-surface-fill, transparent));
```

实心底 + 同色半透明蒙层 → 色调与官方菜单一致，但完全不透明。想换回官方的毛玻璃效果，把这两行换成：

```css
background: var(--dsw-specific-menu);
backdrop-filter: var(--dsw-menu-backdrop-filter);
```

### 不可换的部分

尺寸（弹层 480px、行高 36px、圆角 14px/9px、字号 13px/11px）是写死在 CSS 里的——当前 DSH 没有暴露 radius / spacing / 字号令牌。换主题不会影响这些尺寸。

## 数据与隐私

- 模块三（[lib/host.js](lib/host.js) 的复盘分析器）只读会话事件流与投影、注册一个工具和一条命令，不写会话日志、不联网。复盘完会把报告写到 `<DSH_HOME>/dsh-limbs/reviews/<sessionId>.md`（本机状态目录，**不进 git**，也不进项目），并按「最近 20 份 / 30 天内」清理旧文件。
- 模块二的 Host 保存接口只写 `<DSH_HOME>/dsh-limbs/model-settings.json`：推理档位字段 + 账号分桶 + 时间戳，不写会话日志、不联网、不碰模型目录。
- 模块三不发送任何模型请求，报告在本地算完直接返回。
- 所有模型数据来自官方 `ctx.modelDirectories`（底层 `session.modelCatalog` / `session.selectModel`），插件自己不维护第二份目录。
- 没有外部网络请求；`LIMBS_META` 是编译在文件里的静态表，不是远程拉取。
- 模块七（[lib/handoff.js](lib/handoff.js) 的窗口交接）：`assemble` 读 `PROJECT_PROGRESS.md` / `PROJECT_STATUS.md` / 最新 devlog 后按 cwd 注入，`lookup` 按 id 取冷存档，`commit` 校验一次性令牌后写 devlog + 账行并跑工程自检。
  令牌由两个入口发：模型侧的 `handoff_request_token`（只按**本轮人类用户消息里有没有授权语**判定，模型改不了 user message 所以无法自问自答）与人工侧的 `/limbs-handoff-token`。令牌落 `<DSH_HOME>/dsh-limbs/handoff-tokens.json`，一次性、30 分钟有效、按会话记账，不进 git。

## 已知限制

- **不做「管理提供商」入口**：客户端插件可用的服务目录里没有打开设置页的导航接口，提供商仍用 `/model` 命令管理。
- **不支持模型 Logo 图片**：不内置品牌资源、不下载外部图片，统一用首字母占位块（可用 `providers[id].mark` 定制文字）。
- **不接管子槽**：不渲染 `conversation.input.model.label` / `.options` 的第三方贡献（官方控件仍会渲染它们）。
- **subagent 会话不显示该座位**：与官方行为一致。
- 推理档位切换只对声明了 `reasoning` 的模型出现；没有该字段的提供商不显示胶囊。
- **模块二的「模型选择」是只读展示**：设置分区没有 session，模型仍在 composer 选择器里切换；恢复默认不改变当前模型。
- **模块二的同步范围是同一台 Host**：Host 文件按账号分桶、多窗口可同步；跨设备需要 DSH 账号后端接口，当前版本没有该通道，页面会明确显示「已保存到本机」或「服务端已同步」。
- **模块二不再有档位控件**：上下文挡位与档位条滑杆已于 2026-11-26 删除（假控件 + 与 chips 重复，见 `Docs/design/PRD.md` §5）；设置页只剩「默认推理强度」与「费用超限时提示」。

## 目录结构

```
package.json        # bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml    # 加载器补丁：插入 dsh-limbs 条目
lib/host.js         # Host 半侧：模块三复盘分析器 + 模块二保存接口 + 模块七/八挂载点
lib/review-store.js # 模块三：复盘报告落盘 / 读回 / 清理（B2）
lib/handoff.js      # 模块七：窗口交接（assemble / lookup / 令牌 / commit，纯 Host 半边）
lib/handoff-config.js # 模块八：项目管理配置接口（/limbs/handoff-config + /limbs/handoff-project）
lib/client.js       # Client 半侧：座位注册 + 双栏抽屉 + 模型管理页 + 模块八项目管理页 + 全部 CSS
lib/model-management/levels.js  # 模块二档位单一真源 + 旧配置映射
locale/en.json      # 插件列表标题/描述（英文）
locale/zh.json      # 插件列表标题/描述（中文）
icon.svg            # 插件图标
```

> **`Docs/` 与 `tools/` 不随包发布** —— `Docs/` 是工程治理文档（设计、决策、踩坑、任务记录），
> 只有这个 README 是给用户的。要看设计细节请到仓库：
> <https://github.com/APFSDS-Dog/dsh-limbs/tree/main/Docs>

## 开发

无构建步骤，`lib/client.js` 就是浏览器直接加载的模块。改完保存 → 刷新页面（桌面版 `Ctrl+R`）即可看到效果；[tools/reload-window.ps1](tools/reload-window.ps1) 可以代你给 DSH 窗口发一次 `Ctrl+R`。

`lib/host.js` 是 Host 半侧，**刷新页面不会重载它——改完必须重启 DSH**。

离线测试（不启动 DSH，用 Electron 当 Node）：

```pwsh
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH 可执行文件>' .dev\postmortem-test.mjs
& '<DSH 可执行文件>' .dev\postmortem-test.mjs --print   # 附带打印一份样例报告
& '<DSH 可执行文件>' .dev\review-store-test.mjs         # 模块三报告落盘 / 读回 / 清理
& '<DSH 可执行文件>' .dev\review-home-smoke.mjs          # 用真实 DSH_HOME 冒烟落点（写完就删）
& '<DSH 可执行文件>' .dev\model-management-test.mjs     # 模块二档位
& '<DSH 可执行文件>' .dev\open-settings-test.mjs        # 设置跳转回归
& '<DSH 可执行文件>' .dev\ui-shell-test.mjs             # 模块三 UI 回归
& '<DSH 可执行文件>' .dev\handoff-test.mjs              # 模块七（含打印拼装文本与 dry-run 报告、令牌五条）
& '<DSH 可执行文件>' .dev\handoff-config-test.mjs       # 模块八段 1：inject 开关 + 配置接口
& '<DSH 可执行文件>' .dev\projects-ui-test.mjs          # 模块八段 2：左栏入口 + 一级页
& '<DSH 可执行文件>' .dev\host-bridge-test.mjs        # Host 三桥挂载（webServer 迟到 / 缺席 / 重复）
& '<DSH 可执行文件>' .dev\projects-detail-test.mjs      # 模块八段 3：二级页
& '<DSH 可执行文件>' tools\render-check.mjs             # 模块一选择器回归
```

> 条数以每套脚本自己的输出为准（`passed, 0 failed`），**不在文档里写死** —— 加了断言就会过期。

真机复查（**只读**、重启 DSH 后跑）：

```pwsh
pwsh -File tools\host-diagnose.ps1       # ① 三桥挂没挂 ② 诊断文件 ③ 路由探活 ④ 源码/进程时间对照
pwsh -File tools\review-store-check.ps1  # ⑤ 报告落盘的落点是否成立
```

`host-diagnose.ps1` 是排查「面板显示 Host 接口没挂上」时的**第一条命令**。它先验对照组（未注册路径也必须是 404，否则 404 不能当证据），再逐个探六条 `/limbs/*`，最后读插件自己写的 `<DSH_HOME>/dsh-limbs/host-status.json`。

`review-store-check.ps1` 判据五条：目录里有报告 / 正文含「最该做的三条」/ 章节号没乱 / 份数 ≤ 20 / 正文无 frontmatter。全 PASS 才算 B2 在真机上成立。

调试样式最快的办法：DevTools 里直接改 `<style id="dsh-limbs-styles">`（或模块八的 `dsh-limbs-m8-styles`），满意后再同步回 `lib/client.js` 的 `CSS` / `M8_CSS` 模板字符串。

> 模块八（项目管理）的 Host 侧只在 `lib/handoff-config.js` 里动 `<项目根>/.dsh/handoff.yaml`；
> Client 不直接写文件。桌面端不经过 Host 渲染 `index.html`，所以页面全局令牌走
> `webserver/index-inject` 的结构化注入，`tapIndex` 那条是 Web 部署才用。

## License

MIT
