# dsh-limbs

> DSH 的「手脚」：把 composer 里那个朴素的模型选择器，换成一个可搜索、双栏、键盘可用的版本——数据仍然来自 DSH 官方目录，不联网、不另存一份。

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

### 其它

本插件没有需要持久化的配置项，也不写任何本地文件。想改语言文案，编辑 `lib/client.js` 里的 `STR`（`zh` / `en` 两套，按 `navigator.language` 选择）。

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

- Host 半侧（[lib/host.js](lib/host.js)）是空实现：不注册工具、不建服务、不联网、不持久化。
- 所有模型数据来自官方 `ctx.modelDirectories`（底层 `session.modelCatalog` / `session.selectModel`），插件自己不维护第二份目录。
- 没有任何外部请求；`LIMBS_META` 是编译在文件里的静态表，不是远程拉取。

## 已知限制

- **不做「管理提供商」入口**：客户端插件可用的服务目录里没有打开设置页的导航接口，提供商仍用 `/model` 命令管理。
- **不支持模型 Logo 图片**：不内置品牌资源、不下载外部图片，统一用首字母占位块（可用 `providers[id].mark` 定制文字）。
- **不接管子槽**：不渲染 `conversation.input.model.label` / `.options` 的第三方贡献（官方控件仍会渲染它们）。
- **subagent 会话不显示该座位**：与官方行为一致。
- 推理档位切换只对声明了 `reasoning` 的模型出现；没有该字段的提供商不显示胶囊。

## 目录结构

```
package.json        # bundle 清单：dsh.bundle.patch + dsh.client
cordis.patch.yml    # 加载器补丁：插入 dsh-limbs 条目
lib/host.js         # Host 半侧：空实现占位（不联网、不持久化）
lib/client.js       # Client 半侧：座位注册 + 双栏抽屉 + 全部 CSS
locale/en.json      # 插件列表标题/描述（英文）
locale/zh.json      # 插件列表标题/描述（中文）
docs/DETAIL.md      # 插件详情页文档
icon.svg            # 插件图标
tools/              # 开发期 PowerShell 辅助脚本，不随包发布
```

## 开发

无构建步骤，`lib/client.js` 就是浏览器直接加载的模块。改完保存 → 刷新页面（桌面版 `Ctrl+R`）即可看到效果；[tools/reload-window.ps1](tools/reload-window.ps1) 可以代你给 DSH 窗口发一次 `Ctrl+R`。

调试样式最快的办法：DevTools 里直接改 `<style id="dsh-limbs-styles">`，满意后再同步回 `lib/client.js` 的 `CSS` 模板字符串。

## License

MIT
