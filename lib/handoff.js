/**
 * Host half of dsh-limbs — 模块七：窗口交接（Handoff）。
 *
 * 三段（**一个模块，不拆插件**，见 Docs/design/MODULE7-HANDOFF.md §三）：
 *
 *   assemble  渲染热层四段，经 `agent/pre-step` 注入（**不是** system prompt 区段）
 *   lookup    按 id 取冷存档正文、按关键词 grep 账表
 *   commit    收尾：算 id → 拼账行与 devlog 正文 → **本轮只 dry-run，不落盘**
 *
 * ── 为什么走 `agent/pre-step` 而不是 `systemPrompt.section()` ────────────
 *
 * `systemPrompt.section()` 的 `PromptSection` 是 `{name, order, text}`，没有 cwd，
 * 注册落在插件 scope（全局）。拿它做按项目注入 = A 项目的任务账注入到 B 项目。
 * `agent/pre-step` 的回调里有 `agent`，`agent.session.header.cwd` 就是本项目根
 * （已在 `@deepseek-ai/dsh-session` 源码核实：`SessionHeader.cwd`）。
 *
 * ── 注入位次与频率（照抄官方 dsh-agent-instructions，不自创）──────────────
 *
 * 官方 `src/index.ts` 的 `ctx.on('agent/pre-step')`：
 *   const decision = await next()
 *   desired = await compose(...)                      // 内部读 cwd
 *   if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
 *     syncInbox(agent, messages, desired); return decision   // 挂 inbox 等下一轮
 *   }
 *   const i = decision.messages.findLastIndex(m => messages.includes(m))
 *   return { ...decision, messages: decision.messages.toSpliced(i + 1, 0, desired) }
 *
 * 频率：`agent/pre-step` 是**每步**钩子。每步注入会让 prompt 前缀持续变化，
 * 缓存命中率掉下来（决策记录 §8.2）。所以**每个 agent 只注入一次**（首步）。
 *
 * ── 零依赖 ────────────────────────────────────────────────────────
 *
 * 刻意不 import `@deepseek-ai/*`：第三方插件装进 profile 时解析不到 dsh 安装内的
 * 包（profile 的 node_modules 只有 cosmokit / schemastery）。所以消息对象按形状
 * 自己造，等价于 `createUserMessage({ content, source })` 的产物。
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────
// 0. 常量
// ─────────────────────────────────────────────────────────────────────

/** 账表滑窗：渲染时截取最近 N 行（**视图，不是存储形态**，见决策记录 D2）。 */
export const LEDGER_RECENT_LIMIT = 10

/** 账行六列，顺序即格式（决策记录 D2）。 */
export const LEDGER_COLUMNS = ['id', 'title', 'status', 'conclusion', 'archive', 'next']

/** 状态四值（`check_docs.py` 第 16 项也守这一条）。 */
export const LEDGER_STATUSES = ['done', 'doing', 'blocked', 'dropped']

/** 四段的键（英文键、中文值，决策记录 §8.1）。 */
export const DEVLOG_SECTIONS = ['goal', 'confirmed_facts', 'excluded_paths', 'todos']

/** `t-YYYYMMDD-NN`。 */
export const TASK_ID_PATTERN = /^t-(\d{8})-(\d{2})$/

const DEFAULT_PROGRESS = 'PROJECT_PROGRESS.md'
const DEFAULT_STATUS = 'PROJECT_STATUS.md'
const DEFAULT_DEVLOG_DIR = 'Docs/devlog'

/** 本文件所在目录的上一级 = 工程根（lib/ 与 tools/ 平级）。 */
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─────────────────────────────────────────────────────────────────────
// 1. 账表 / 待拍板 / 快照 的解析
// ─────────────────────────────────────────────────────────────────────

/**
 * 按**位置**认账行，不按内容认。
 *
 * ⚠️ MODULE7 §八#2 的坑：第一版自检只认「以 `t-` 开头的行」，结果 `task-1`
 * 这种坏 id 整行漏检 —— 格式错了反而不报红。所以这里认「首格带反引号 +
 * 至少六列」，与 `check_docs.py` 第 16 项同一判据。
 *
 * @param {string} markdown PROJECT_PROGRESS.md 全文
 * @returns {Array<{id: string, title: string, status: string, conclusion: string, archive: string, next: string}>}
 */
export function parseLedgerRows(markdown) {
  const rows = []
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (!/^\|\s*`/.test(line)) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.length < LEDGER_COLUMNS.length) continue
    const clean = cells.map(cell => cell.replace(/^`|`$/g, '').trim())
    rows.push({
      id: clean[0],
      title: clean[1],
      status: clean[2],
      conclusion: clean[3],
      archive: clean[4],
      next: clean.slice(5).join(' | '),
    })
  }
  return rows
}

/** 取某个二级标题（`## xxx`）下的正文，直到下一个同级或更高级标题。 */
function sectionBody(markdown, headingPattern) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s/.test(line) && headingPattern.test(line))
  if (start < 0) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

/** 取三级标题（`### xxx`）下的正文，直到下一个同级或更高级标题。 */
function subsectionBody(markdown, headingPattern) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const start = lines.findIndex(line => /^###\s/.test(line) && headingPattern.test(line))
  if (start < 0) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

/**
 * §3.3 待拍板**全部，不剪**（漏一条就会重复问，决策记录 U3 第 2 段）。
 *
 * @param {string} markdown PROJECT_PROGRESS.md 全文
 * @returns {{pending: string, decided: string}}
 */
export function parsePendingDecisions(markdown) {
  return {
    pending: subsectionBody(markdown, /待拍板/).trim(),
    decided: subsectionBody(markdown, /已拍板/).trim(),
  }
}

/**
 * `PROJECT_STATUS.md` §二 实测快照（带核对日期），第 3 段。
 *
 * @param {string} markdown PROJECT_STATUS.md 全文
 * @returns {string}
 */
export function parseStatusSnapshot(markdown) {
  return sectionBody(markdown, /实测状态快照/).trim()
}

/** 从 `PROJECT_STATUS.md` 全文里取核对日期（`YYYY-MM-DD`），拿不到返回 null。 */
export function parseStatusCheckedAt(markdown) {
  const body = parseStatusSnapshot(markdown)
  const match = /核对日期[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(body)
  return match === null ? null : match[1]
}

// ─────────────────────────────────────────────────────────────────────
// 2. devlog（冷存档）的解析
// ─────────────────────────────────────────────────────────────────────

/**
 * 按 `## <英文键>` 切四段。缺段不算错 —— 返回 null 由调用方决定说什么。
 *
 * @param {string} markdown devlog 全文
 * @returns {Record<string, string|null>}
 */
export function parseDevlogSections(markdown) {
  const text = String(markdown ?? '')
  const sections = {}
  for (const key of DEVLOG_SECTIONS) {
    const pattern = new RegExp('^##\\s+' + key + '\\s*$')
    const body = sectionBody(text, pattern).trim()
    sections[key] = body === '' ? null : body
  }
  return sections
}

/**
 * 取 `Docs/devlog/` 里 id 最大的那份（`t-` 前缀让字典序 = 时间序，决策记录 D3）。
 *
 * @param {string} dir
 * @returns {Promise<string|null>} 文件名（不含目录），没有则 null
 */
export async function latestDevlogFile(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const candidates = names.filter(name => /^t-\d{8}-\d{2}_.*\.md$/.test(name))
  if (candidates.length === 0) return null
  candidates.sort()
  return candidates[candidates.length - 1]
}

// ─────────────────────────────────────────────────────────────────────
// 3. 读输入（只读）
// ─────────────────────────────────────────────────────────────────────

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 读装配器需要的三份输入。**只读，不写**。
 *
 * @param {string} [projectRoot]
 * @returns {Promise<{
 *   projectRoot: string,
 *   progress: string|null, status: string|null,
 *   ledgerRows: Array<object>, pending: string, decided: string,
 *   statusSnapshot: string, statusCheckedAt: string|null,
 *   latestDevlog: string|null, latestDevlogSections: Record<string, string|null>|null,
 * }>}
 */
export async function readHandoffInputs(projectRoot = MODULE_ROOT) {
  const root = resolve(projectRoot)
  const progress = await readTextIfExists(join(root, DEFAULT_PROGRESS))
  const status = await readTextIfExists(join(root, DEFAULT_STATUS))
  const devlogDir = join(root, DEFAULT_DEVLOG_DIR)
  const latestDevlog = await latestDevlogFile(devlogDir)
  const latestText = latestDevlog === null ? null : await readTextIfExists(join(devlogDir, latestDevlog))
  const decisions = parsePendingDecisions(progress ?? '')
  return {
    projectRoot: root,
    progress,
    status,
    ledgerRows: parseLedgerRows(progress ?? ''),
    pending: decisions.pending,
    decided: decisions.decided,
    statusSnapshot: parseStatusSnapshot(status ?? ''),
    statusCheckedAt: parseStatusCheckedAt(status ?? ''),
    latestDevlog,
    latestDevlogSections: latestText === null ? null : parseDevlogSections(latestText),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. assemble：热层四段
// ─────────────────────────────────────────────────────────────────────

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 账表滑窗：最近 N 行，渲染成 markdown 表。 */
export function renderLedgerWindow(rows, limit = LEDGER_RECENT_LIMIT) {
  const recent = rows.slice(-limit)
  const lines = [
    '| id | 标题 | 状态 | 结论 | 存档 | next |',
    '|---|---|---|---|---|---|',
  ]
  for (const row of recent) {
    lines.push(`| \`${row.id}\` | ${row.title} | \`${row.status}\` | ${row.conclusion} | ${row.archive} | ${row.next} |`)
  }
  return lines.join('\n')
}

/**
 * 渲染热层四段（决策记录 U3 / MODULE7 §4.5，按「缺了就会问重复问题」排序）。
 *
 * ⚠️ `AGENTS.md` 已由 DSH 整份注入，**这里不注入任何契约**。
 *
 * @param {object} inputs `readHandoffInputs()` 的返回值
 * @returns {string} markdown
 */
export function composeHotLayer(inputs) {
  const rows = inputs?.ledgerRows ?? []
  const blocks = []

  blocks.push(
    '## 一、任务账（最近 ' + Math.min(rows.length, LEDGER_RECENT_LIMIT) + ' 行）',
  )
  blocks.push(rows.length === 0
    ? '_账表为空。_'
    : renderLedgerWindow(rows))

  blocks.push('## 二、待拍板（全部，不剪）')
  blocks.push(inputs?.pending === '' || inputs?.pending === undefined
    ? '_§3.3 无待拍板条目。_'
    : inputs.pending)

  blocks.push('## 三、实测状态快照' + (inputs?.statusCheckedAt ? `（核对日期 ${inputs.statusCheckedAt}）` : ''))
  blocks.push(inputs?.statusSnapshot === '' || inputs?.statusSnapshot === undefined
    ? '_PROJECT_STATUS.md §二 未取到。_'
    : inputs.statusSnapshot)

  blocks.push('## 四、上一次交接的「遗留问题与下一步」')
  const todos = inputs?.latestDevlogSections?.todos ?? null
  if (todos === null) {
    blocks.push('_没有可用的 devlog「todos」段。_')
  } else {
    blocks.push(`_来源：\`${inputs.latestDevlog}\`_`)
    blocks.push(todos)
  }

  const header = [
    '【模块七 · 窗口交接 · 热层注入】',
    '',
    '以下是本项目（cwd）的既有任务账与待拍板，**已定的事不要再问一遍**。',
    '需要更多细节用 `handoff_lookup` 按 id 取冷存档；要收尾请项目主说「任务收尾」。',
    '',
  ].join('\n')

  return header + blocks.join('\n\n') + '\n'
}

/** 造一条消息，形状等价于 dsh-llm 的 `createUserMessage({content, source})` 产物。 */
export function createLocalUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text: String(text) }]),
    // `kind: 'user'` 是目前最兼容的选择：官方 `MessageSourceMap` 里就有它，
    // 不会走到「未知来源」的分支。`form` 省略即文档默认形态。
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * 造一个 `agent/pre-step` 监听器。
 *
 * 语义照抄官方 `dsh-agent-instructions`：
 *   1. 先 `await next()` 拿 decision，绝不抢在别人前面改
 *   2. `reject` 或「首步且没消息」→ 挂 `inbox` 等下一轮，不把上下文变成独立请求
 *   3. 否则插在**用户提问之后**（`decision.messages` 里最后一个「本批已认领」之后）
 *   4. 每个 agent 只注入一次（决策记录 §8.2：每步注入会砸缓存命中率）
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] 强制工程根（默认从 agent.session.header.cwd 取）
 * @param {(root: string) => Promise<string|null>} [options.compose] 可替换的渲染器（测试用）
 * @returns {{listener: Function, stats: {injected: number, deferred: number, skipped: number}}}
 */
export function createHandoffAssembler(options = {}) {
  const stats = { injected: 0, deferred: 0, skipped: 0 }
  const done = new WeakSet()
  const compose = options.compose ?? (async root => composeHotLayer(await readHandoffInputs(root)))

  const listener = async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent === undefined || agent === null) return decision

    if (done.has(agent)) {
      stats.skipped += 1
      return decision
    }

    const root = options.projectRoot ?? agent?.session?.header?.cwd ?? null
    if (typeof root !== 'string' || root === '') {
      // cwd 缺失 = 这个会话不属于任何项目，注入什么都是串话。
      stats.skipped += 1
      return decision
    }

    let text
    try {
      text = await compose(root)
    } catch {
      // 装配失败绝不阻断用户那一轮 —— 交接是增强，不是必经之路。
      stats.skipped += 1
      return decision
    }
    if (typeof text !== 'string' || text.trim() === '') {
      stats.skipped += 1
      return decision
    }

    const message = createLocalUserMessage(text)

    if (decision.kind === 'reject' || (payload.step === 1 && decision.messages.length === 0)) {
      // 空首轮不要占轮：把上下文挂到 inbox 待命，下一轮自然带进去。
      try {
        agent.inbox?.prepend?.('next-step', message)
      } catch {
        return decision
      }
      done.add(agent)
      stats.deferred += 1
      return decision
    }

    const claimed = Array.isArray(payload.messages) ? payload.messages : []
    let index = -1
    for (let i = decision.messages.length - 1; i >= 0; i -= 1) {
      if (claimed.includes(decision.messages[i])) { index = i; break }
    }
    const messages = decision.messages.toSpliced(index + 1, 0, message)
    done.add(agent)
    stats.injected += 1
    return { ...decision, messages }
  }

  return { listener, stats }
}

// ─────────────────────────────────────────────────────────────────────
// 5. lookup：按 id 取冷存档、按关键词 grep 账表
// ─────────────────────────────────────────────────────────────────────

/**
 * 按 id 取 devlog 正文。
 *
 * @param {string} id `t-YYYYMMDD-NN`
 * @param {string} [projectRoot]
 * @returns {Promise<{found: boolean, id: string, path: string|null, text: string|null, reason?: string}>}
 */
export async function lookupDevlog(id, projectRoot = MODULE_ROOT) {
  const root = resolve(projectRoot)
  const normalized = String(id ?? '').trim()
  if (!TASK_ID_PATTERN.test(normalized)) {
    return {
      found: false,
      id: normalized,
      path: null,
      text: null,
      reason: `id 格式应为 t-YYYYMMDD-NN（收到 ${JSON.stringify(normalized)}）`,
    }
  }
  const dir = join(root, DEFAULT_DEVLOG_DIR)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return { found: false, id: normalized, path: null, text: null, reason: 'Docs/devlog 目录不存在' }
  }
  const file = names.find(name => name.startsWith(normalized + '_') && name.endsWith('.md'))
  if (file === undefined) {
    const progress = await readTextIfExists(join(root, DEFAULT_PROGRESS))
    const onLedger = parseLedgerRows(progress ?? '').some(row => row.id === normalized)
    return {
      found: false,
      id: normalized,
      path: null,
      text: null,
      reason: onLedger
        ? '账表里有这个 id，但没有对应的冷存档（`存档` 列应为 `—`：未开工任务）'
        : '账表和 Docs/devlog 里都没有这个 id',
    }
  }
  const text = await readTextIfExists(join(dir, file))
  return { found: text !== null, id: normalized, path: join(dir, file), text }
}

/**
 * 按关键词检索账表（id / 标题 / 结论 / next 任一命中）。
 *
 * @param {string} keyword
 * @param {string} [projectRoot]
 * @returns {Promise<{keyword: string, matches: Array<object>}>}
 */
export async function searchLedger(keyword, projectRoot = MODULE_ROOT) {
  const root = resolve(projectRoot)
  const wanted = String(keyword ?? '').trim()
  if (wanted === '') return { keyword: wanted, matches: [] }
  const needle = wanted.toLowerCase()
  const progress = await readTextIfExists(join(root, DEFAULT_PROGRESS))
  const matches = parseLedgerRows(progress ?? '').filter(row =>
    [row.id, row.title, row.conclusion, row.next].some(field => oneLine(field).toLowerCase().includes(needle)))
  return { keyword: wanted, matches }
}

// ─────────────────────────────────────────────────────────────────────
// 6. commit —— **本轮只 dry-run**
// ─────────────────────────────────────────────────────────────────────

/** 本地日期部分（`YYYYMMDD`）。不吃 UTC，避免跨时区错一天。 */
export function dateStamp(now = new Date()) {
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * 算下一个 `task_id`：**扫两处**取当天最大 NN 再 +1（决策记录 D1）。
 *
 *   ① `Docs/devlog/` 的文件名
 *   ② `PROJECT_PROGRESS.md` 账表里的 `id`
 *
 * 只看 devlog 会撞号 —— 账本允许有「未开工任务」，它的 id 只存在于账本里。
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {Date} [options.now]
 * @returns {Promise<{id: string, stamp: string, fromDevlog: number, fromLedger: number, max: number}>}
 */
export async function nextTaskId(options = {}) {
  const root = resolve(options.projectRoot ?? MODULE_ROOT)
  const stamp = dateStamp(options.now ?? new Date())

  let fromDevlog = 0
  try {
    for (const name of await readdir(join(root, DEFAULT_DEVLOG_DIR))) {
      const match = /^t-(\d{8})-(\d{2})_/.exec(name)
      if (match !== null && match[1] === stamp) fromDevlog = Math.max(fromDevlog, Number(match[2]))
    }
  } catch {
    /* 目录缺失按 0 计 */
  }

  let fromLedger = 0
  const progress = await readTextIfExists(join(root, DEFAULT_PROGRESS))
  for (const row of parseLedgerRows(progress ?? '')) {
    const match = TASK_ID_PATTERN.exec(row.id)
    if (match !== null && match[1] === stamp) fromLedger = Math.max(fromLedger, Number(match[2]))
  }

  const max = Math.max(fromDevlog, fromLedger)
  return {
    id: `t-${stamp}-${String(max + 1).padStart(2, '0')}`,
    stamp,
    fromDevlog,
    fromLedger,
    max,
  }
}

/** 校验收尾条目：六列齐全、状态四值、标题与结论长度上限（决策记录 D2）。 */
export function validateLedgerEntry(entry) {
  const problems = []
  const value = entry ?? {}
  if (typeof value.title !== 'string' || value.title.trim() === '') problems.push('缺 title')
  else if (value.title.trim().length > 15) problems.push(`title 超 15 字（${value.title.trim().length}）`)
  if (typeof value.conclusion !== 'string' || value.conclusion.trim() === '') problems.push('缺 conclusion')
  else if (value.conclusion.trim().length > 20) problems.push(`conclusion 超 20 字（${value.conclusion.trim().length}）`)
  if (!LEDGER_STATUSES.includes(value.status)) problems.push(`status=${JSON.stringify(value.status)} 不在四值内`)
  if (typeof value.next !== 'string' || value.next.trim() === '') problems.push('缺 next（没有就写 —）')
  return { ok: problems.length === 0, problems }
}

/** 把一条账行渲染成六列 markdown（顺序即 `check_docs.py` 的判据）。 */
export function renderLedgerRow(id, entry) {
  const cells = [
    `\`${id}\``,
    entry.title.trim(),
    `\`${entry.status}\``,
    entry.conclusion.trim(),
    entry.status === 'done' ? `\`${id}\`` : '—',
    entry.next.trim(),
  ]
  return '| ' + cells.join(' | ') + ' |'
}

/**
 * 渲染 devlog 正文（四段格式，样本见 `Docs/devlog/t-20261120-02_开发交接.md`）。
 *
 * @param {string} id
 * @param {object} entry 六列 + 四段
 * @param {Date} [now]
 * @returns {string}
 */
export function renderDevlog(id, entry, now = new Date()) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const sections = entry.sections ?? {}
  const lines = [
    `# ${id} · ${entry.title.trim()}`,
    '',
    `> \`id\` \`${id}\` ｜ ${date} ｜ 状态 **${entry.status}**`,
    '',
    '## goal',
    '',
    String(sections.goal ?? entry.goal ?? '（待填）').trim(),
    '',
    '## confirmed_facts',
    '',
    String(sections.confirmed_facts ?? entry.confirmed_facts ?? '（待填）').trim(),
    '',
    '## excluded_paths',
    '',
    String(sections.excluded_paths ?? entry.excluded_paths ?? '（待填）').trim(),
    '',
    '## todos',
    '',
    String(sections.todos ?? entry.todos ?? '（待填）').trim(),
    '',
  ]
  return lines.join('\n')
}

/** devlog 的目标文件名（D3：`t-YYYYMMDD-NN_<词根>.md`）。 */
export function devlogFileName(id, suffix = '开发交接') {
  return `${id}_${suffix}.md`
}

/**
 * 收尾的 **dry-run**：算出 id、拼出要写的内容，**什么都不写盘**。
 *
 * 这里刻意不实现写盘与令牌：MODULE7 §六 的顺序是
 * `assemble` → `lookup` → `commit`（第一版只 dry-run），
 * 且口令令牌一旦真写就是改台账的动作，要先让人看过输出。
 *
 * @param {object} options
 * @param {string} [options.projectRoot]
 * @param {Date} [options.now]
 * @param {object} options.entry 标题 / 状态 / 结论 / next / 四段
 * @returns {Promise<object>}
 */
export async function dryRunCommit(options = {}) {
  const root = resolve(options.projectRoot ?? MODULE_ROOT)
  const now = options.now ?? new Date()
  const entry = options.entry ?? {}

  const validation = validateLedgerEntry(entry)
  const next = await nextTaskId({ projectRoot: root, now })
  const ledgerRow = validation.ok ? renderLedgerRow(next.id, entry) : null
  const devlogBody = renderDevlog(next.id, entry, now)
  const devlogPath = join(root, DEFAULT_DEVLOG_DIR, devlogFileName(next.id))
  const exists = await (async () => {
    try {
      const names = await readdir(join(root, DEFAULT_DEVLOG_DIR))
      return names.some(name => name.startsWith(next.id + '_'))
    } catch {
      return false
    }
  })()

  return {
    dryRun: true,
    wrote: false,
    id: next.id,
    idBasis: next,
    validation,
    ledgerRow,
    ledgerWrite: `PROJECT_PROGRESS.md §二 追加一行：\n${ledgerRow ?? '（账行未通过校验，不生成）'}`,
    devlogPath,
    devlogFileName: devlogFileName(next.id),
    devlogExists: exists,
    devlogBody,
    // 让人一眼看清「这轮承诺了什么、没做什么」。
    notYetImplemented: [
      '口令令牌的发放与校验（D0-1）：未实现，本轮不写盘所以不需要',
      '真正写盘（devlog + 账行 upsert）：未实现，dry-run 只打印',
      '跑 check_docs.py 做写入后自检（U7）：未实现，因为没有写入',
    ],
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. 注册（工具面）
// ─────────────────────────────────────────────────────────────────────

/** 工具输出契约：模型看到的是一段 Markdown 文本。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

export const LOOKUP_TOOL_NAME = 'handoff_lookup'
export const COMMIT_DRY_RUN_TOOL_NAME = 'handoff_commit_dry_run'

/**
 * 挂载模块七的工具。`assemble` 由调用方的 `agent/pre-step` 负责，这里不做。
 *
 * @param {object} ctx
 * @param {{projectRoot?: string, now?: () => Date}} [options]
 * @returns {{disposers: Array<() => void>}} 精确 disposer（与 `ctx.effect` 一致）
 */
export function applyHandoffTools(ctx, options = {}) {
  const root = options.projectRoot ?? MODULE_ROOT
  const now = options.now ?? (() => new Date())
  const disposers = []

  disposers.push(ctx.tools.register({
    name: LOOKUP_TOOL_NAME,
    description:
      '模块七 · 交接检索（只读）：按 id 取 Docs/devlog 冷存档正文，或按关键词 grep PROJECT_PROGRESS.md 账表。'
      + '不写任何文件。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id，形如 t-20261120-02；给了就取该冷存档正文。' },
        keyword: { type: 'string', description: '关键词；给了就检索账表（id / 标题 / 结论 / next）。' },
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    execute: async args => {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const keyword = typeof args?.keyword === 'string' ? args.keyword.trim() : ''
      if (id === '' && keyword === '') return '要给 `id` 或 `keyword` 之一，否则没有可检索的东西。'

      const blocks = []
      if (id !== '') {
        const found = await lookupDevlog(id, root)
        if (found.found) {
          blocks.push(`### 冷存档 \`${id}\`\n\n来源：\`${found.path}\`\n\n` + found.text)
        } else {
          blocks.push(`### 冷存档 \`${id}\`\n\n未取到：${found.reason}`)
        }
      }
      if (keyword !== '') {
        const searched = await searchLedger(keyword, root)
        if (searched.matches.length === 0) {
          blocks.push(`### 账表检索「${keyword}」\n\n没有命中。`)
        } else {
          blocks.push(`### 账表检索「${keyword}」（${searched.matches.length} 行）\n\n`
            + renderLedgerWindow(searched.matches, searched.matches.length))
        }
      }
      return blocks.join('\n\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: COMMIT_DRY_RUN_TOOL_NAME,
    description:
      '模块七 · 收尾 **dry-run**（不写盘）：算出 task_id、拼出账行与 devlog 正文并打印。'
      + '本轮刻意不落盘，也没有口令令牌校验。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '账行标题，≤15 字。' },
        status: { type: 'string', enum: LEDGER_STATUSES, description: '状态四值。' },
        conclusion: { type: 'string', description: '账行结论，≤20 字。' },
        next: { type: 'string', description: '账行 next 一句话；没有就写 —。' },
        goal: { type: 'string', description: 'devlog 段 goal。' },
        confirmed_facts: { type: 'string', description: 'devlog 段 confirmed_facts。' },
        excluded_paths: { type: 'string', description: 'devlog 段 excluded_paths。' },
        todos: { type: 'string', description: 'devlog 段 todos。' },
      },
      required: ['title', 'status', 'conclusion', 'next'],
    },
    output: TEXT_OUTPUT,
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    execute: async args => {
      const result = await dryRunCommit({
        projectRoot: root,
        now: now(),
        entry: {
          title: String(args?.title ?? ''),
          status: String(args?.status ?? ''),
          conclusion: String(args?.conclusion ?? ''),
          next: String(args?.next ?? ''),
          sections: {
            goal: args?.goal,
            confirmed_facts: args?.confirmed_facts,
            excluded_paths: args?.excluded_paths,
            todos: args?.todos,
          },
        },
      })
      return renderDryRunReport(result)
    },
  }))

  return { disposers }
}

/**
 * 把 dry-run 结果渲染成一段人可核的 markdown。
 *
 * @param {object} result `dryRunCommit()` 的返回值
 * @returns {string}
 */
export function renderDryRunReport(result) {
  const lines = [
    '# 模块七收尾 · dry-run（**没有写任何文件**）',
    '',
    `- 算出的 id：\`${result.id}\``,
    `- 依据：devlog 当天最大 = \`${String(result.idBasis.fromDevlog).padStart(2, '0')}\`，`
      + `账表当天最大 = \`${String(result.idBasis.fromLedger).padStart(2, '0')}\` → 取 \`${result.id}\``,
    `- 账行校验：${result.validation.ok ? '通过' : '未通过 —— ' + result.validation.problems.join('；')}`,
    `- 目标 devlog：\`${result.devlogPath}\`${result.devlogExists ? '（⚠️ 已存在同名，真写时会拒写）' : '（同名不存在）'}`,
    '',
    '## 要追加的账行',
    '',
    '```text',
    result.ledgerRow ?? '（未生成）',
    '```',
    '',
    '## 要写入的 devlog 正文',
    '',
    '```markdown',
    result.devlogBody.trimEnd(),
    '```',
    '',
    '## 本轮刻意没做什么',
    '',
    ...result.notYetImplemented.map(item => `- ${item}`),
    '',
  ]
  return lines.join('\n')
}
