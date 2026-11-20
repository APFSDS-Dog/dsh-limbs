# 市场 PR 交接 · dsh-limbs

> 写下时间：2026-11-16 18:00（Asia/Hong_Kong）
> 用途：换 Agent 或换人接手时先读这一份，不用翻聊天记录。
> 本文件只讲「市场收录」这条线；插件功能、开发踩坑见 `PROJECT_PROGRESS.md`。

---

## 一、一句话状态

**已上架，收尾完成。** 收录条目由 PR #15241 合并生效；11-16 误开的重复 PR #15840 已清理掉属于本插件的那条，不再有重复风险。

---

## 二、市场收录进度

| PR | 标题 | 状态 | 条目文件 |
|---|---|---|---|
| [#15241](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15241) | Add apfsds-dog/dsh-limbs (ui) | ✅ **MERGED**（`2026-11-15T20:23:05Z`，北京时间 11-16 04:23） | `data/plugins/apfsds-dog__dsh-limbs.yml`（**全小写**） |
| [#15840](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15840) | Add APFSDS-Dog/dsh-api-free-image | ✅ 已瘦身，**不再包含本插件**（`f8f11c4` 删掉了 `APFSDS-Dog__dsh-limbs.yml`） | 只剩 `APFSDS-Dog__dsh-api-free-image.yml` |

### 结论

- **正式条目 = `apfsds-dog__dsh-limbs.yml`（全小写），由 #15241 合并。这就是最终形态，任何情况下都不要再提交第二个 dsh-limbs 条目。**
- 11-16 曾在 #15840 里误带一个 `APFSDS-Dog__dsh-limbs.yml`（大写 D）。Linux 上大小写不同即不同文件，合并后会造成同一插件两条记录。**已于当日删除，PR 现在只含 dsh-api-free-image 一条。**

---

## 三、CI 结论

- **#15241**：已合并，无需关心。
- **#15840**：删掉重复条目后 CI 自动重跑；此前的基线是全绿（`check` pass 33m35s、`Submission gate` pass）。

---

## 四、2026-11-16 这轮做了什么

1. 核实 `gh` CLI 已装（v2.104.0）且已登录 `APFSDS-Dog`。
2. 同步 fork `APFSDS-Dog/awesome-dsh-plugin` 到上游最新 `main`。
3. ⚠️ **失误**：没先回查已有 PR，新建分支 `add-apfsds-dog-plugins` 并开 PR #15840，其中重复带有 dsh-limbs。
4. CI 首轮红（`category: tool` 不存在，只有 `tools`）→ 修正后全绿。
5. 复查时发现 #15241 早已合并 → 从 #15840 删除重复条目（`f8f11c4`），PR 改名为只提 dsh-api-free-image。

---

## 五、待办

- **本插件：无。** 已上架，什么都不用做。
- 以后要提「新增插件」时：**先跑 `gh pr list --author "@me" --state all` 确认没提过**，再动手。
- 若维护者在 #15840 留言要改 dsh-api-free-image，改 YAML 推同一分支即可，不要新开 PR。那部分交接在 `D:\Projects\dsh-kolors-plugi\PR-HANDOFF.md`。

---

## 六、怎么自己复核

`gh` CLI 已装（`C:\Program Files\GitHub CLI\gh.exe`）:

```pwsh
# 我在这个仓库的全部 PR（历史 + 现在）
gh pr list --repo awesome-dsh-plugin/awesome-dsh-plugin --author "@me" --state all

# 确认本插件的正式条目存在（全小写）
gh api "repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/apfsds-dog__dsh-limbs.yml" --jq '.name'

# 确认没有被重复提交（大写文件不应存在）
gh api "repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/APFSDS-Dog__dsh-limbs.yml" --jq '.name'

# 看 #15840 现在还剩哪些文件
gh pr view 15840 --repo awesome-dsh-plugin/awesome-dsh-plugin --json files --jq '.files[].path'
```

---

## 七、别踩的坑

**#1 · `category` 是固定枚举，写错会卡在 `READMEs match data/plugins` 步骤**

合法值（原样，别自己造）：

```
agi, ui, usage, theme, model, identity, session, memory, tools, wsl,
browser, vision, voice, docs, skill, workflow, git, notify, dev,
security, remote, market, fun
```

坑：`tool` 不存在，**只有复数 `tools`**。报错混在"READMEs match"这一步的输出里，第一眼容易误判成 README 有问题。

**#2 · 条目文件名大小写不同 = 两个文件，CI 查不出来**（本次踩到）

`apfsds-dog__x.yml` 与 `APFSDS-Dog__x.yml` 在 GitHub 底层是两个文件，`readEntries()` 会读成两条记录，而查重逻辑看不穿大小写差异 —— CI 全绿也照样会重复上架。

**结论：同一插件永远只用一个文件名，认准已合并的那个（本插件 = 全小写）。**

**#3 · 一个 PR 最多 3 条条目**（`MAX_ENTRIES_PER_PR = 3`），超了 gate 直接红。

**#4 · 仓库年龄门槛 `MIN_AGE_DAYS = 1`**

新仓库当天提交会报 `repository is X.X days old (needs 1)`，每 6 小时自动重跑，满 1 天自动转绿，**不要推空提交去催**。

**#5 · 不要为了让 CI 变绿去改 README**

README 由 `generate-readme.mjs` 从 `data/plugins/` 生成；PR 里碰了 README 反而触发严格比对（`--check`），更容易红。只提交 YAML 最省事。

**#6 · 本文件未提交**

按约定只改文件、不代提交。`PR-HANDOFF.md` 目前是 untracked，要不要入库由阿昆定。
