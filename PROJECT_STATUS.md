# 项目状态总账 ·《dsh-limbs》

> **本文件只装「半年后仍成立」的事** —— 它是**地图与索引**，不是流水账。
> 会随进度变化的（卡点 / 下一步 / 待拍板）→ `PROJECT_PROGRESS.md`
> 这个任务做了什么 → `Docs/devlog/`
> 怎么跑起来 → `README.md`
>
> 最后核对：2026-11-20（⚠️ 每次改动**逐项对照磁盘实际文件**，不凭记忆）
> `check_docs.py` 会守这一行：日期早于本文件最后一次 git 提交时给 ⚠️，写坏成非 `YYYY-MM-DD` 则报红。

---

## 〇、权威性地图（想知道什么 → 看哪份）

| 想知道 | 去哪 |
|---|---|
| 硬契约：红线 / 协作规则 / 技能路由 | `AGENTS.md`（仓库根，唯一真源） |
| **什么内容该写进哪份文件** | `DOCS_LAYOUT.md` |
| **工程分层 / 代码规则 / 命名约定** | `ARCHITECTURE.md` |
| 当前状态（事实）/ 目录职责 | **本文件** |
| 迄今做过啥 / 卡点 / 下一步 / 待拍板 | `PROJECT_PROGRESS.md` |
| 每个任务干了什么、为什么这么定 | `Docs/devlog/` 最新一份 |
| 设计要什么、为什么 | `Docs/design/` |
| 怎么搭、怎么配、机器环境 | `Docs/tech/` |
| 怎么操作 / 怎么跑起来 | `README.md` |
| 重复用的流程 | 技能（清单见 `DOCS_LAYOUT.md` §一 ⑨） |

---

## 一、工程身份

| 项 | 内容 |
|---|---|
| 项目名 | 《dsh-limbs》 |
| 领域 / 定位 | DSH 插件：模型选择器 · 模型管理 · 复盘 · 窗口交接（模块号见 `Docs/design/PRD.md`） |
| 工程根 | `D:\Projects\dsh-limbs`（**换机器按主机名查 `Docs/tech/机器环境档案.md`**） |
| 技术栈 | 原生 ESM JavaScript（**无构建步骤**）+ DSH 插件宿主 API（cordis） |
| 当前阶段 | v0.2（v0.1.0 已发布上架） |
| 数据源 | **无数据表** —— 插件只读写 JSON 配置与 `<DSH_HOME>` 下的状态文件 |
| 发布物 | `lib/` · `Docs/` · `locale/` · `icon.svg` · `cordis.patch.yml` · `README.md`（见 `package.json` 的 `files`） |

> ⚠️ **多机开发**：路径按 `hostname` 查表，别把某一台机器的盘符写成"工程根"。机器相关路径统一放 `Docs/tech/机器环境档案.md`。

---

## 二、实测状态快照

> ⚠️ 本小节**是唯一允许写具体数字的地方** —— 因为它标了核对日期，是"**当时的事实**"，不是永久断言。
> 每次核对**重写整节**，不要追加（追加必腐坏）。

**核对日期：2026-11-20**

| 项 | 实测值 | 怎么核的 |
|---|---|---|
| JS / MJS 源文件 | 4 个（`lib/` 3 · `tools/` 1） | `find lib tools -name "*.js" -o -name "*.mjs"` |
| PowerShell 工具 | 6 个（真机操作用） | `ls tools/*.ps1` |
| 文档数 | 扫描 28 份 | `pwsh -File ./check-docs.ps1` |
| 文档自检 | **14/14 通过**（2 项因技能未装跳过） | 同上 —— ⚠️ **不能用 `python check_docs.py`**，本机 `python` 是 WindowsApps 占位桩 |
| 依赖 / 插件 | 无自带依赖（`node_modules` 不进包）；peer 为宿主提供的 `cordis` / `typert-protocol` / `react` | `package.json` 的 `peerDependencies` |
| 离线测试 | 四套：模型管理 / UI 壳 / 复盘 / 选择器回归 | `$env:ELECTRON_RUN_AS_NODE='1'; & '<DSH exe>' .dev\<test>.mjs`（清单见 `README.md` §开发） |

---

## 三、目录职责

> 只写**稳定**的目录职责；增删目录时同步改这里。
> 文档层的职责边界在 `DOCS_LAYOUT.md`，本节只讲**工程目录**。

| 目录 | 装什么 | 不进 git？ |
|---|---|---|
| `Docs/` | 全部文档（**含随包发布的插件文档**，见 `DOCS_LAYOUT.md`） | — |
| `lib/` | 全部源码：Host 半边 `host.js` · Client 半边 `client.js` · `model-management/` | — |
| `tools/` | 真机操作与回归脚本（PowerShell + mjs） | — |
| `locale/` | 插件多语言 | — |
| `.dev/` | 离线测试与只读排查脚本 | ✅ 忽略 |
| `shots/` | 真机证据图 | ✅ 忽略 |
| `_tmp/` | 草稿与临时产物 | ✅ 建议忽略 |

> 本项目**没有** `Tests/`、`_delivery/`、`_archive/` —— 测试放在 `.dev/`（不进包），交付物直接走 GitHub Release。**不为了齐整去建空目录。**

---

## 四、外部依赖与工具

| 工具 / 服务 | 用途 | 备注 |
|---|---|---|
| DSH 桌面版 | 插件宿主（`0.2.2-rc.5` 起验证过） | 路径**不写死**，见机器环境档案 |
| Electron（随 DSH） | 当 Node 跑离线测试（本机 PATH 无 node） | `ELECTRON_RUN_AS_NODE=1` |
| GitHub · `apfsds-dog/dsh-limbs` | 源码与 Release | `v0.1.0` 已发布，topic `dsh-plugin` |
| awesome-dsh-plugin 市场 | 收录条目 | 条目名 **全小写** `apfsds-dog__dsh-limbs.yml`，已合并 |

---

## 五、当前阶段与指针

- **当前阶段**：v0.2 → 详情见 `PROJECT_PROGRESS.md`
- **卡点 / 下一步 / 待拍板**：**不在本文件** → `PROJECT_PROGRESS.md`
