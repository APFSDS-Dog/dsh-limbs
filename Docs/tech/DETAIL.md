# dsh-limbs

DSH 的「手脚」：把外部平台的能力以模型选择器的形式暴露给用户。

## 它替换了什么

composer 的模型座位（`conversation.input.model`）。本插件以 `priority: -1` 注册同一个座位，遮蔽内置控件（`0`，槽规则为「最低优先级渲染」）；内置包继续挂载，因此 `ctx.modelDirectories` 与 `/model` 命令都保留，两者与本选择器共用同一份每会话目录。

## 模块二 · 模型管理

设置 →「模型管理」是一个全中文单页：

- **当前模型**：只读展示，切换仍在 composer 选择器里。
- **推理摘要**：顶部胶囊显示「推理 · 服务商默认 / 已关闭」等状态。
- **保存**：即时保存 + 乐观更新 + 失败回滚；Host 按账号保存到 `<DSH_HOME>/dsh-limbs/model-settings.json`，按 `updatedAt` 最新优先。
- **恢复默认**：二次确认，只恢复推理档位字段，当前模型不变。

> 2026-11-26 删除：**上下文挡位**（300K / 600K / 1M，假控件 —— 从未传给模型请求）与**档位条滑杆**（`LevelSlider`，与 chips 重复）。理由见 [PRD.md](../design/PRD.md) §5。推理档位的真实切换在模型选择器底部的 chips。

## 使用

- 点 composer 里的模型名打开下拉列表。
- 顶部输入框按模型名、模型 id、描述、提供商名搜索（大小写不敏感）；命中后跨提供商显示，行内标注提供商。
- 左侧点提供商只看该提供商；左右两栏各自滚动。
- `↑` `↓` 移动，`Enter` / `Tab` 确认，`Esc` 关闭。
- 底栏「重新读取」重新拉取模型目录；某个提供商加载失败会显示警告行，其余提供商照常可用。

## 显示层元数据

官方模型目录只有模型名、描述、推理档位和提供方角标，没有价格、倍率、实时负载，也没有模型 Logo。本插件把这几项放在 `lib/client.js` 顶部的 `LIMBS_META`：**目前刻意留空**——界面不显示任何数字（负载圆点为灰色「未知」），图标使用供应商首字母占位块。

有可信数据后可填入，界面立即生效：

```js
const LIMBS_META = {
  providers: { scnet: { mark: 'S' } },
  models: {
    'scnet/GLM-5.3-Flash': { multiplier: '0.69x', discount: '夜间折扣', status: 'idle' },
  },
}
```

`status`：`idle` 绿 / `warn` 黄 / `busy` 红 / 缺省灰（未知）。

## 恢复内置选择器

profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-limbs
  name: dsh-limbs
  disabled: true
```

样式与监听都在 `ctx.effect` 上注册，停用后不留 CSS/DOM 残留。

## 限制

- 没有「管理提供商」入口（刻意不做）：客户端插件没有打开设置页的导航接口，提供商仍用 `/model` 命令管理。
- Host 半侧不联网；模块三读会话日志并把报告写到 `<DSH_HOME>/dsh-limbs/reviews/`，模块二只把推理档位字段写到 `<DSH_HOME>/dsh-limbs/model-settings.json`。
- 模块二跨设备同步需要 DSH 账号后端接口，当前仅同一 Host 多窗口同步。
- 不渲染 `conversation.input.model.label` / `.options` 子槽的第三方贡献。
- 已寻址的 subagent 会话不暴露该座位。
