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

import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
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
  const limit = Number.isInteger(inputs?.ledgerRecent) && inputs.ledgerRecent > 0
    ? inputs.ledgerRecent
    : LEDGER_RECENT_LIMIT
  const blocks = []

  blocks.push(
    '## 一、任务账（最近 ' + Math.min(rows.length, limit) + ' 行）',
  )
  blocks.push(rows.length === 0
    ? '_账表为空。_'
    : renderLedgerWindow(rows, limit))

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
  const compose = options.compose ?? (async root => {
    // U5：项目级配置只管本项目自己的开关项（例如滑窗行数）。
    // 读不到配置就用默认值 —— 缺失**不是错误**（§5.6「缺失即用默认值」）。
    const { config } = await readHandoffConfig(root)
    const inputs = await readHandoffInputs(root)
    return composeHotLayer({ ...inputs, ledgerRecent: config.ledgerRecent })
  })

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
// 6b. 写盘段：令牌（D0-1）· 项目配置（U5）· 权限档（U6）· 真写 + 写后自检 + 撤回（Q4=A）
// ─────────────────────────────────────────────────────────────────────
//
// 默认值按「宁可功能残缺，不留能写进去但校验不住的口子」定：
//   · 真写默认**关闭**（`write: false`）
//   · 只有「有令牌」+「配置里显式开启」两个条件**同时**成立才落盘
//   · 落盘后立刻跑工程自检；红了就**撤回**（删 devlog + 还原账表），绝不留半截

/** 项目级配置文件名（U5 / §5.6）。插件全局安装，配置必须落项目里。 */
export const HANDOFF_CONFIG_PATH = join('.dsh', 'handoff.yaml')

/**
 * 配置默认值。**真写默认关**。
 *
 * 与 `MODULE7` §5.4 的差异（要如实记）：那里说 Config 用 schemastery 的
 * `z.object({...})`。但这个插件刻意零依赖（装进 profile 后解析不到
 * `@deepseek-ai/*`，`@deepseek-ai/schemastery` 也不在 profile 的 node_modules 里），
 * 所以这里手写解析 + 手写默认值。代价：没有 schema 校验，改由 `resolveHandoffConfig()`
 * 逐字段收敛，坏值回退默认并记进 `warnings`。
 */
export const DEFAULT_HANDOFF_CONFIG = Object.freeze({
  /** 真写总开关。false = 无论有没有令牌都不落盘。 */
  write: false,
  /** 写完跑哪个自检脚本。空串 = 自动探测。 */
  checkCommand: '',
  /** 账表滑窗行数（assemble 用）。 */
  ledgerRecent: LEDGER_RECENT_LIMIT,
})

/** 极简 YAML 解析：只支持 `key: value` 单层标量与 `#` 注释。够用就不引依赖。 */
export function parseHandoffYaml(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (line === '') continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value === '') { out[match[1]] = ''; continue }
    if (/^(true|yes|on)$/i.test(value)) { out[match[1]] = true; continue }
    if (/^(false|no|off)$/i.test(value)) { out[match[1]] = false; continue }
    if (/^-?\d+$/.test(value)) { out[match[1]] = Number(value); continue }
    out[match[1]] = value.replace(/^['"]|['"]$/g, '')
  }
  return out
}

/**
 * 把磁盘值收敛成可信配置；坏值逐条回退默认，并留下 `warnings`。
 *
 * @param {object} [raw]
 * @returns {{config: object, warnings: string[], found: boolean}}
 */
export function resolveHandoffConfig(raw) {
  const warnings = []
  const config = { ...DEFAULT_HANDOFF_CONFIG }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const found = Object.keys(source).length > 0

  if ('write' in source) {
    if (typeof source.write === 'boolean') config.write = source.write
    else warnings.push(`write=${JSON.stringify(source.write)} 不是布尔值，回退 false`)
  }
  if ('checkCommand' in source) {
    if (typeof source.checkCommand === 'string') config.checkCommand = source.checkCommand
    else warnings.push(`checkCommand 不是字符串，回退自动探测`)
  }
  if ('ledgerRecent' in source) {
    const value = Number(source.ledgerRecent)
    if (Number.isInteger(value) && value > 0 && value <= 100) config.ledgerRecent = value
    else warnings.push(`ledgerRecent=${JSON.stringify(source.ledgerRecent)} 不合法，回退 ${LEDGER_RECENT_LIMIT}`)
  }
  for (const key of Object.keys(source)) {
    if (!(key in DEFAULT_HANDOFF_CONFIG)) warnings.push(`未知配置项 ${key}（忽略）`)
  }
  return { config, warnings, found }
}

/**
 * 读项目级配置；文件缺失 = 用默认值（**不报错**）。
 *
 * @param {string} projectRoot
 * @returns {Promise<{config: object, warnings: string[], path: string, found: boolean}>}
 */
export async function readHandoffConfig(projectRoot) {
  const path = join(resolve(projectRoot), HANDOFF_CONFIG_PATH)
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { ...resolveHandoffConfig({}), path, found: false }
  }
  return { ...resolveHandoffConfig(parseHandoffYaml(text)), path }
}

// ── 令牌（D0-1）───────────────────────────────────────────────────────
//
// 「口令即授权」：项目主说「任务收尾」→ 发一个一次性令牌；**用掉即作废**。
// 令牌落 `<DSH_HOME>/dsh-limbs/handoff-tokens.json`（§5.5：不进 git），
// 会话内有效 —— 用 `sessionId` 记账，同一会话重复喊口令不产生第二份。

/** 令牌文件（`ctx.get('dshHomePath')` 优先，缺失时退回 `DSH_HOME`）。 */
export function handoffTokenFile(ctx) {
  const fallback = process.env.DSH_HOME
  // 服务提供的解析器含 `~` 展开与规范化；拿不到才回退环境变量。
  // ⚠️ 回退到临时目录会让令牌重启即失效 —— 所以宁可用 DSH_HOME，也不用 tmpdir。
  if (typeof ctx?.get === 'function') {
    try {
      const resolveHome = ctx.get('dshHomePath')
      if (typeof resolveHome === 'function') return resolveHome('dsh-limbs', 'handoff-tokens.json')
    } catch { /* 服务缺席，走回退 */ }
  }
  if (typeof fallback === 'string' && fallback !== '') {
    return join(fallback, 'dsh-limbs', 'handoff-tokens.json')
  }
  return join(process.cwd(), '.dsh', 'handoff-tokens.json')
}

async function readTokenStore(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 发一个一次性令牌（项目主说「任务收尾」时调用）。
 *
 * @param {object} ctx
 * @param {{sessionId?: string, now?: () => Date}} [options]
 * @returns {Promise<{token: string, sessionId: string, issuedAt: number}>}
 */
export async function issueHandoffToken(ctx, options = {}) {
  const file = handoffTokenFile(ctx)
  const sessionId = String(options.sessionId ?? 'default')
  const now = options.now ?? (() => new Date())
  const token = randomBytes(16).toString('hex')
  const store = await readTokenStore(file)
  const issuedAt = now().getTime()
  store[sessionId] = { token, issuedAt, used: false }
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8').catch(async () => {
    // 目录可能不存在；建一次再写。
    await import('node:fs/promises').then(fs => fs.mkdir(dirname(file), { recursive: true }))
    await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
  })
  return { token, sessionId, issuedAt }
}

/**
 * 校验并**消费**令牌：验过就立刻作废（一次性）。
 *
 * @param {object} ctx
 * @param {{sessionId?: string, token?: string}} [options]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function consumeHandoffToken(ctx, options = {}) {
  const file = handoffTokenFile(ctx)
  const sessionId = String(options.sessionId ?? 'default')
  const provided = String(options.token ?? '')
  const store = await readTokenStore(file)
  const record = store[sessionId]
  if (record === undefined) {
    return { ok: false, reason: '缺口令：本会话没有已发放的令牌。请项目主先说「任务收尾」' }
  }
  if (record.used === true) {
    return { ok: false, reason: '缺口令：该口令已用过（令牌一次性，用完即作废）' }
  }
  if (provided === '' || provided !== record.token) {
    return { ok: false, reason: '缺口令：提供的令牌与会话记录不符' }
  }
  store[sessionId] = { ...record, used: true, usedAt: Date.now() }
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
  return { ok: true }
}

// ── 权限档（U6 / §5.3）────────────────────────────────────────────────

/**
 * 读当前会话的权限档。**read-only 直接抛错**，绝不静默跳过（§八#6）。
 *
 * @param {object} ctx
 * @param {object} [session]
 * @returns {{mode: string, workspaceRoot: string|null}}
 * @throws {Error} 只读时
 */
export function assertWritablePolicy(ctx, session) {
  const service = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  if (service === undefined || service === null || typeof service.resolve !== 'function') {
    // 服务缺席 ≠ 能写。按 fail-safe 处理：拿不到策略就不许写。
    throw new Error('拿不到 sandboxPolicy 服务，无法确认工作区可写；本次写入已取消。'
      + '（这是 fail-safe：宁可不写，也不静默当通过）')
  }
  const policy = service.resolve(session === undefined ? {} : { session })
  const mode = String(policy?.mode ?? '')
  if (mode === 'read-only') {
    throw new Error('工作区为只读（read-only），无法写入 Docs/devlog/ 与 PROJECT_PROGRESS.md；'
      + '请切到 workspace-write 后再说一次「任务收尾」。')
  }
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new Error(`无法识别的权限档 ${JSON.stringify(mode)}；本次写入已取消。`)
  }
  return { mode, workspaceRoot: policy?.workspaceRoot ?? null }
}

// ── 写后自检（Q4 选 A）───────────────────────────────────────────────

/** 探测工程里的自检脚本（`check-docs.ps1` 优先，其次 `check_docs.py`）。 */
export async function detectCheckCommand(projectRoot) {
  const root = resolve(projectRoot)
  for (const [file, build] of [
    ['check-docs.ps1', () => ({ command: 'pwsh', args: ['-NoProfile', '-File', join(root, 'check-docs.ps1')] })],
    ['check_docs.py', () => ({ command: 'python', args: [join(root, 'check_docs.py')] })],
  ]) {
    try {
      const names = await readdir(root)
      if (names.includes(file)) return build()
    } catch { /* 目录读不了就当没有 */ }
  }
  return null
}

/**
 * 跑工程自检。
 *
 * @param {string} projectRoot
 * @param {string} [explicit] 配置里指定的命令（空白 = 自动探测）
 * @returns {Promise<{available: boolean, ok: boolean, code: number|null, output: string, command: string|null}>}
 */
export async function runProjectCheck(projectRoot, explicit = '') {
  let plan = null
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    // 配置给了完整命令：按 shell 语义拆成 argv（只支持「命令 + 参数」，不引 shell）。
    const parts = explicit.trim().split(/\s+/)
    plan = { command: parts[0], args: parts.slice(1) }
  } else {
    plan = await detectCheckCommand(projectRoot)
  }
  if (plan === null) {
    return { available: false, ok: false, code: null, output: '', command: null }
  }
  const result = await new Promise(done => {
    execFile(
      plan.command,
      plan.args,
      { cwd: resolve(projectRoot), timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        const text = `${stdout ?? ''}${stderr ?? ''}`
        done({
          code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
          text,
        })
      },
    )
  })
  return {
    available: true,
    ok: result.code === 0,
    code: result.code,
    output: result.text,
    command: [plan.command, ...plan.args].join(' '),
  }
}

// ── 账行 upsert ─────────────────────────────────────────────────────

/**
 * 把一行账追加到账表**最后一个账表分组末尾**（只增行、不重排）。
 *
 * 同 id 已存在 → 视为 upsert 的「更新」分支，**替换那一行**（决策记录 D1 第三节）。
 * 找不到插入点 → 抛错（宁可失败，不把账行写到错误位置）。
 *
 * @param {string} markdown
 * @param {string} row 渲染好的六列行
 * @param {string} id
 * @returns {{markdown: string, action: 'inserted'|'replaced'}}
 */
export function upsertLedgerRow(markdown, row, id) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const rowIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\|\s*`/.test(lines[i])) continue
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    if (cells.length < LEDGER_COLUMNS.length) continue
    rowIndexes.push(i)
  }
  if (rowIndexes.length === 0) throw new Error('账表里找不到任何账行，无法确定追加位置')

  const existing = rowIndexes.find(index => {
    const first = lines[index].trim().replace(/^\|/, '').split('|')[0].trim().replace(/^`|`$/g, '')
    return first === id
  })
  if (existing !== undefined) {
    lines[existing] = row
    return { markdown: lines.join('\n'), action: 'replaced' }
  }

  const last = rowIndexes[rowIndexes.length - 1]
  lines.splice(last + 1, 0, row)
  return { markdown: lines.join('\n'), action: 'inserted' }
}

// ── 真写（默认关）────────────────────────────────────────────────────

/**
 * 收尾的**真写**入口。默认仍是 dry-run：只有「有令牌 + 配置显式开启」才落盘。
 *
 * 完整的四道闸，顺序不可换：
 *   ① 令牌（D0-1）       —— 没有令牌一律拒绝，并说明缺口令
 *   ② 权限档（U6）       —— read-only 显式报错
 *   ③ 配置（U5）         —— `.dsh/handoff.yaml` 的 write 必须为 true
 *   ④ 写后自检（Q4=A）   —— 跑工程自检，红了**撤回本次写入**并抛错
 *
 * @param {object} options
 * @param {object} options.ctx Host ctx（要取 dshHomePath / sandboxPolicy）
 * @param {object} [options.session] 本会话（传给 sandboxPolicy.resolve）
 * @param {string} [options.sessionId] 令牌记账用
 * @param {string} [options.token] 口令令牌
 * @param {boolean} [options.force] 跳过「配置 write」闸（仅供离线测试）
 * @param {string} [options.projectRoot]
 * @param {Date} [options.now]
 * @param {object} options.entry
 * @returns {Promise<object>}
 */
export async function commitHandoff(options = {}) {
  const root = resolve(options.projectRoot ?? MODULE_ROOT)
  const now = options.now ?? new Date()
  const entry = options.entry ?? {}

  const validation = validateLedgerEntry(entry)
  if (!validation.ok) {
    return {
      wrote: false,
      refusedAt: 'validation',
      reason: `账行未通过校验：${validation.problems.join('；')}`,
      validation,
    }
  }

  // 闸 ①：令牌
  const tokenCheck = await consumeHandoffToken(options.ctx, {
    sessionId: options.sessionId,
    token: options.token,
  })
  if (!tokenCheck.ok) {
    return { wrote: false, refusedAt: 'token', reason: tokenCheck.reason, validation }
  }

  // 闸 ②：权限档
  let policy
  try {
    policy = assertWritablePolicy(options.ctx, options.session)
  } catch (error) {
    return {
      wrote: false,
      refusedAt: 'sandbox',
      reason: error instanceof Error ? error.message : String(error),
      validation,
    }
  }

  // 闸 ③：配置
  const configRead = await readHandoffConfig(root)
  if (configRead.config.write !== true && options.force !== true) {
    return {
      wrote: false,
      refusedAt: 'config',
      reason: `项目配置 write=false（${configRead.path}），真写默认关闭。`
        + '要落盘请在项目里建 .dsh/handoff.yaml 并写 `write: true`。',
      config: configRead.config,
      configPath: configRead.path,
      validation,
    }
  }

  const next = await nextTaskId({ projectRoot: root, now })
  const devlogPath = join(root, DEFAULT_DEVLOG_DIR, devlogFileName(next.id))
  const progressPath = join(root, DEFAULT_PROGRESS)

  // 同名 devlog 拒写（幂等第二层）
  try {
    const names = await readdir(join(root, DEFAULT_DEVLOG_DIR))
    if (names.some(name => name.startsWith(next.id + '_'))) {
      return {
        wrote: false,
        refusedAt: 'idempotent',
        reason: `Docs/devlog 里已有 ${next.id}_ 开头的文件，拒写（不覆盖、不追加）`,
        id: next.id,
        validation,
      }
    }
  } catch { /* 目录不存在时下面写会失败，交给它报 */ }

  const originalProgress = await readFile(progressPath, 'utf8')
  const ledgerRow = renderLedgerRow(next.id, entry)
  const devlogBody = renderDevlog(next.id, entry, now)
  const upserted = upsertLedgerRow(originalProgress, ledgerRow, next.id)

  // ── 落盘（先 devlog 后账表；任一步失败都要回滚）──
  const wroteFiles = []
  try {
    await writeFile(devlogPath, devlogBody, 'utf8')
    wroteFiles.push(devlogPath)
    await writeFile(progressPath, upserted.markdown, 'utf8')
    wroteFiles.push(progressPath)
  } catch (error) {
    await rollbackWrite({ devlogPath, progressPath, originalProgress, wroteFiles })
    return {
      wrote: false,
      refusedAt: 'io',
      reason: `写盘失败已回滚：${error instanceof Error ? error.message : String(error)}`,
      validation,
    }
  }

  // 闸 ④：写后自检（Q4=A）
  const check = await runProjectCheck(root, configRead.config.checkCommand)
  if (!check.available) {
    // 降级条款：显式告知，不许静默当通过。
    return {
      wrote: true,
      degraded: true,
      note: '本项目无自检脚本（找不到 check-docs.ps1 / check_docs.py），本次写入未经校验',
      id: next.id,
      devlogPath,
      progressPath,
      ledgerAction: upserted.action,
      policy,
      config: configRead.config,
      validation,
    }
  }
  if (!check.ok) {
    const rolledBack = await rollbackWrite({
      devlogPath, progressPath, originalProgress, wroteFiles,
    })
    return {
      wrote: false,
      refusedAt: 'self-check',
      reason: `工程自检未通过（exit ${check.code}），本次写入已撤回`
        + (rolledBack ? '，两处文件已恢复原样' : '，但撤回时出错，请人工核对'),
      rolledBack,
      check,
      id: next.id,
      validation,
    }
  }

  return {
    wrote: true,
    id: next.id,
    idBasis: next,
    devlogPath,
    progressPath,
    ledgerRow,
    ledgerAction: upserted.action,
    policy,
    config: configRead.config,
    configWarnings: configRead.warnings,
    check,
    validation,
  }
}

/**
 * 撤回一次写入：删掉新建的 devlog、把账表还原成写入前的原文。
 *
 * @param {{devlogPath: string, progressPath: string, originalProgress: string, wroteFiles: string[]}} input
 * @returns {Promise<boolean>} 是否完全恢复
 */
export async function rollbackWrite(input) {
  let ok = true
  try {
    await unlink(input.devlogPath)
  } catch { /* 可能本来就没写成 */ }
  try {
    await writeFile(input.progressPath, input.originalProgress, 'utf8')
  } catch {
    ok = false
  }
  // 复核：账表必须与原文一致，devlog 必须不存在。
  try {
    const after = await readFile(input.progressPath, 'utf8')
    if (after !== input.originalProgress) ok = false
  } catch {
    ok = false
  }
  return ok
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
export const COMMIT_TOOL_NAME = 'handoff_commit'

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

  disposers.push(ctx.tools.register({
    name: COMMIT_TOOL_NAME,
    description:
      '模块七 · 收尾**真写**：校验一次性口令令牌 → 权限档 → 项目配置（write: true）→ 写 devlog + 追加账行'
      + ' → 立刻跑工程自检；自检报红则**撤回本次写入**并抛错。默认 dry-run：真写平时是关的。',
    parameters: {
      type: 'object',
      properties: {
        token: { type: 'string', description: '一次性口令令牌（项目主说「任务收尾」后发放）。' },
        session_id: { type: 'string', description: '令牌记账用；不给就用 default。' },
        title: { type: 'string', description: '账行标题，≤15 字。' },
        status: { type: 'string', enum: LEDGER_STATUSES, description: '状态四值。' },
        conclusion: { type: 'string', description: '账行结论，≤20 字。' },
        next: { type: 'string', description: '账行 next 一句话；没有就写 —。' },
        goal: { type: 'string', description: 'devlog 段 goal。' },
        confirmed_facts: { type: 'string', description: 'devlog 段 confirmed_facts。' },
        excluded_paths: { type: 'string', description: 'devlog 段 excluded_paths。' },
        todos: { type: 'string', description: 'devlog 段 todos。' },
      },
      required: ['token', 'title', 'status', 'conclusion', 'next'],
    },
    output: TEXT_OUTPUT,
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const result = await commitHandoff({
        ctx,
        session: exec?.agent?.session,
        sessionId: args?.session_id,
        token: args?.token,
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
      return renderCommitReport(result)
    },
  }))

  // 令牌发放入口：项目主说「任务收尾」时由人（或缺席时的流程）调一次。
  // 不做成工具 —— 它是**授权动作**，不该由模型自行触发（D0：程序只能提醒，不能触发）。
  if (typeof ctx.commands?.register === 'function') {
    disposers.push(ctx.commands.register({
      name: 'limbs-handoff-token',
      description: '模块七 · 发放一次性收尾令牌（D0-1）：说「任务收尾」后跑一次，令牌用掉即作废。',
      input: { hint: '[session_id] 记账键，默认 default' },
      handler: async invocation => {
        const sessionId = String(invocation.rawInput ?? '').trim() || 'default'
        try {
          const issued = await issueHandoffToken(ctx, { sessionId, now })
          return {
            kind: 'success',
            text: `已发放一次性收尾令牌（session=${issued.sessionId}）：\n\n${issued.token}\n\n`
              + '它只能用于一次收尾，用掉即作废。调用 `handoff_commit` 时把它作为 `token` 传入。',
          }
        } catch (error) {
          return {
            kind: 'error',
            text: `发放令牌失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    }))
  }

  return { disposers }
}

/**
 * 把真写结果渲染成一段人可核的 markdown（成功 / 各级拒绝都要能读懂）。
 *
 * @param {object} result `commitHandoff()` 的返回值
 * @returns {string}
 */
export function renderCommitReport(result) {
  if (result.wrote === true) {
    const lines = [
      '# 模块七收尾 · **已写入**',
      '',
      `- id：\`${result.id}\``,
      `- devlog：\`${result.devlogPath}\``,
      `- 账行：\`${result.ledgerAction === 'replaced' ? '替换同 id 行' : '追加到账表末尾'}\``,
      `- 权限档：${result.policy?.mode}${result.policy?.workspaceRoot ? `（${result.policy.workspaceRoot}）` : ''}`,
      '',
    ]
    if (result.degraded === true) {
      lines.push('## ⚠️ 警告', '', result.note, '')
    } else {
      lines.push('## 写后自检', '', `- 命令：\`${result.check.command}\``,
        `- 结果：**通过**（exit ${result.check.code}）`, '')
    }
    if (Array.isArray(result.configWarnings) && result.configWarnings.length > 0) {
      lines.push('## 配置告警', '', ...result.configWarnings.map(item => `- ${item}`), '')
    }
    lines.push('## 已追加的账行', '', '```text', result.ledgerRow, '```', '')
    return lines.join('\n')
  }
  const gateNames = {
    validation: '账行校验',
    token: '口令令牌（D0-1）',
    sandbox: '权限档（U6）',
    config: '项目配置（U5）',
    idempotent: '幂等（同名 devlog 拒写）',
    io: '写盘',
    'self-check': '写后自检（Q4=A）',
  }
  const lines = [
    `# 模块七收尾 · **未写入**（闸：${gateNames[result.refusedAt] ?? result.refusedAt}）`,
    '',
    result.reason,
    '',
  ]
  if (result.refusedAt === 'self-check' && result.check !== undefined) {
    lines.push('## 自检输出', '', '```text', String(result.check.output ?? '').slice(0, 4000), '```',
      '', `- 撤回是否完全恢复：**${result.rolledBack ? '是' : '否 —— 请人工核对'}**`, '')
  }
  if (result.refusedAt === 'config' && result.configPath !== undefined) {
    lines.push('## 怎么打开真写', '',
      `1. 建 \`${result.configPath}\``,
      '2. 写一行 `write: true`',
      '3. 让项目主说「任务收尾」拿令牌，再调 `handoff_commit`', '')
  }
  return lines.join('\n')
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
