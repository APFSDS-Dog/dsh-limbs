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

/**
 * 授权的白名单语句（D0-1：一句话 = 一次授权）。
 *
 * 只认**人类自己打出**的这些句子；模型改不了 user message，所以它没法自问自答。
 * 判据见 `authorizationFromTurn`：光有 `source.kind === 'user'` 不够 ——
 * 模块七自己注入的热层消息也是 `kind: 'user'`（`createLocalUserMessage`），
 * 而且正文里就写着「要收尾请项目主说「任务收尾」」。拿正文当授权 = 热层自己授权自己。
 * 真正的人类输入多一个 `rpcId`（官方 `'user-rpc'` 源），这是唯一的可靠区分。
 */
export const AUTHORIZATION_PHRASES = [
  '任务收尾',
  '收尾吧',
  '可以收尾',
  '收尾了',
  '结算一下',
]

/**
 * 允许包在口令外面的**语气字**（前缀 ≤ 3 字、后缀 ≤ 4 字）。
 * 这些字之外的东西一律算「说话的内容」，不算语气 —— 于是「先别收尾吧」这类反悔语
 * 因为「先」「别」不在表里，自然判不成授权，不需要另立反悔词表。
 */
const AUTHORIZATION_WRAPPER_CHARS = new Set([
  '好', '行', '那', '就', '现', '在', '可', '以', '来', '开', '始', '我', '们', '吧', '喽',
  '了', '啊', '啦', '呢', '呗', '哦', '噢', '嘛', '呀', '哈', '哟', '哇', '是', '对',
])
const AUTHORIZATION_PREFIX_MAX = 3
const AUTHORIZATION_SUFFIX_MAX = 4

/**
 * 口令判据：**这一条消息本身就是在下口令**，不是「提到口令这个词」。
 *
 * ⚠️ 真机实测踩到的坑：本轮 user message 里写着「令牌只能由 `/limbs-handoff-token` 发放…
 * 项目主说「任务收尾」后，agent 无法自己拿令牌」——这是**描述**，不是下口令。
 * 只要按「任意子串包含」判，这条描述就被判成授权，一发令牌就变成了**模型给自己发**，
 * 正好把 D0-1 破掉。所以判据必须是「整句就是口令」。
 *
 * 做法：抹掉标点/空白/引号（**引号一律抹掉**：被引号包住的多半是转述），压缩成一串，
 * 再从两头剥掉**纯语气字**（各限 3 / 4 字），剥完必须**整串就是不剩别的**地等于一个口令短语。
 * 剥不干净（中间夹着别的内容）一律不命中 —— 包括任何把短语夹在长句里的写法。
 *
 * ⚠️ 这是启发式，不是语法：它保证「描述性的长句不会被误判成授权」，
 * 但保证不了「所有真授权都被认出来」（「收尾吧，别的明天说」不认）。宁可漏认 ——
 * 漏认的代价是项目主再说一遍，误认的代价是模型绕过授权自己发令牌。
 *
 * @param {string} text 一条消息的纯文本
 * @returns {string|null} 命中的短语；没命中返回 null
 */
export function matchAuthorizationPhrase(text) {
  const compact = String(text ?? '')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/[“”"'‘’「」『』（）()［］\[\]【】《》<>]/g, '')
    .replace(/[\s，,。.!！?？、；;：:~～…—\-]+/g, '')
    .trim()
  if (compact === '') return null

  // 从两头剥语气字：前缀 ≤ 3、后缀 ≤ 4。
  let head = 0
  while (head < AUTHORIZATION_PREFIX_MAX
    && head < compact.length
    && AUTHORIZATION_WRAPPER_CHARS.has(compact[head])) head += 1
  const leading = compact.slice(0, head)
  let tail = compact.length
  while (compact.length - tail < AUTHORIZATION_SUFFIX_MAX
    && tail > head
    && AUTHORIZATION_WRAPPER_CHARS.has(compact[tail - 1])) tail -= 1
  const middleHead = head
  const middle = compact.slice(middleHead, tail)

  // 中间必须是**恰好**一个口令短语。
  for (const phrase of AUTHORIZATION_PHRASES) {
    if (middle === phrase) return phrase
  }

  // 前缀 / 后缀剥过头的兜底：口令本身可能整个就是 wrapper 字的一部分（例如「收尾吧」的「吧」）。
  // 这里再试一次「只剥后缀」与「只剥前缀」，覆盖「好，收尾吧」「任务收尾了吧」两种情况。
  for (const phrase of AUTHORIZATION_PHRASES) {
    if (compact === phrase) return phrase
    if (compact.startsWith(phrase)) {
      const rest = compact.slice(phrase.length)
      if (rest.length > 0 && rest.length <= AUTHORIZATION_SUFFIX_MAX
        && [...rest].every(char => AUTHORIZATION_WRAPPER_CHARS.has(char))) return phrase
    }
    if (compact.endsWith(phrase)) {
      const rest = compact.slice(0, compact.length - phrase.length)
      if (rest.length > 0 && rest.length <= AUTHORIZATION_PREFIX_MAX
        && [...rest].every(char => AUTHORIZATION_WRAPPER_CHARS.has(char))) return phrase
    }
  }
  return null
}

/** 一次性令牌有效期：30 分钟。够收尾一次，过期即废（跨会话另有 sessionId 记账）。 */
export const HANDOFF_TOKEN_TTL_MS = 30 * 60 * 1000

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
    // 模块八 · 热注入开关：关掉后 assemble 一律不产出文本（listener 记 skipped）。
    // 这是项目主的第一诉求 —— 一个开关就能让交接安静下来，不必卸载插件。
    if (config.inject !== true) return null
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

/**
 * 把一条账行渲染成六列 markdown（顺序即 `check_docs.py` 的判据）。
 *
 * `存档` 列按 `DOCS_LAYOUT` §②B 判定：**有冷存档就写 id，没有写 `—`** ——
 * 判据是「这份任务有没有 devlog」，**不是**它的状态。
 * （早期实现误用 `status === 'done'`：真机首跑就撞上——`doing` 的子任务明明写了
 * devlog，账行却标 `—`。`t-20261120-01` 那种「模块级父任务」才是真的没有 devlog。）
 *
 * @param {string} id
 * @param {object} entry
 * @param {{hasDevlog?: boolean}} [options] 不给则按「子任务默认有」处理
 */
export function renderLedgerRow(id, entry, options = {}) {
  const hasDevlog = options.hasDevlog ?? true
  const cells = [
    `\`${id}\``,
    entry.title.trim(),
    `\`${entry.status}\``,
    entry.conclusion.trim(),
    hasDevlog ? `\`${id}\`` : '—',
    entry.next.trim(),
  ]
  return '| ' + cells.join(' | ') + ' |'
}

/**
 * 渲染 devlog 正文（四段格式，样本见 `Docs/devlog/` 里任意一份 `t-*_<摘要>.md`）。
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

/**
 * devlog 文件名的摘要上限（字）。账行标题本身就 ≤15 字，这里再兜一层，
 * 免得将来放宽标题限制时文件名跟着长成一句小作文。
 */
export const DEVLOG_SUMMARY_MAX = 15

/** Windows / POSIX 都不许出现在文件名里的字符（`\ / : * ? " < > |`）。 */
const FILENAME_ILLEGAL = /[\\/:*?"<>|]/g
/** 除空白以外的控制字符（0x00–0x1F、0x7F）：`\t`/`\n` 先按空白处理，剩下的直接删。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * 把账行标题收敛成文件名里的**内容摘要**（`DOCS_LAYOUT` §④：命名是
 * `t-YYYYMMDD-NN_<内容摘要>.md`，摘要写「这块做了什么」，不要「开发交接」这种空词）。
 *
 * 规则（顺序有讲究）：
 *   ① 空白（含制表 / 换行）→ `-`，连续空白压成一个
 *   ② 去掉文件名非法字符与其余控制字符 —— **先清洗再截断**：非法字符不该占 15 字配额
 *   ③ 收尾把首尾与重复的 `-` 合并，不留 `__` / `-_` 这类毛刺
 *   ④ 最后按**字数**（不是字节）截到 `DEVLOG_SUMMARY_MAX`
 *
 * 拿不到标题 → **抛错**，不返回「开发交接」之类的默认词：编出来的摘要会让
 * `ls Docs/devlog/` 那一列全是同一个空词，等于把「一眼看出干了啥」这个目的废掉。
 *
 * @param {unknown} title 账行「标题」列
 * @returns {string} 非空摘要
 */
export function devlogSummary(title) {
  const raw = typeof title === 'string' ? title : ''
  const summary = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(FILENAME_ILLEGAL, '')
    .replace(CONTROL_CHARS, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (summary === '') {
    throw new Error('devlog 摘要拿不到 title —— 不自己编，请先给账行标题')
  }
  // 截断按字数算（`Array.from` 走码点），中文不会被劈开；切在连字符上也要收掉。
  return Array.from(summary).slice(0, DEVLOG_SUMMARY_MAX).join('').replace(/-+$/g, '')
}

/**
 * devlog 的目标文件名（D3：`t-YYYYMMDD-NN_<内容摘要>.md`）。
 *
 * ⚠️ **摘要必须来自真实标题**：拿不到就抛（见 `devlogSummary`）。
 * 任何调用方都不许在这里塞默认词 —— 那是「静默编数据」。
 *
 * @param {string} id `t-YYYYMMDD-NN`
 * @param {string} title 账行「标题」列
 * @returns {string}
 */
export function devlogFileName(id, title) {
  return `${id}_${devlogSummary(title)}.md`
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
  // 文件名带内容摘要；**校验没过的账行不生成文件名** —— 缺 title 就去编一个，
  // 那是静默造数据。报告里会写明「账行未通过校验，不生成文件名」。
  const devlogName = validation.ok ? devlogFileName(next.id, entry.title) : null
  const devlogPath = devlogName === null ? null : join(root, DEFAULT_DEVLOG_DIR, devlogName)
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
    devlogFileName: devlogName,
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
  /** 热注入总开关（模块八新增，默认开）。false = assemble 一律不注入。 */
  inject: true,
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
  if ('inject' in source) {
    if (typeof source.inject === 'boolean') config.inject = source.inject
    else warnings.push(`inject=${JSON.stringify(source.inject)} 不是布尔值，回退 true`)
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
//
// 两个发放入口，同一套存储、同一套语义：
//   人：`/limbs-handoff-token`（兜底，永远可用）
//   模型：`handoff_request_token`（先验**本轮人类授权语**，验过才发）

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
 * 发一个一次性令牌。两个入口共用它（§5.5 同一个存储、同一套语义）：
 *
 *   人：`/limbs-handoff-token`（兜底，永远可用）
 *   模型：`handoff_request_token`（先验本轮人类授权语，验过才发）
 *
 * @param {object} ctx
 * @param {{sessionId?: string, now?: () => Date, reason?: string}} [options]
 * @returns {Promise<{token: string, sessionId: string, issuedAt: number, expiresAt: number}>}
 */
export async function issueHandoffToken(ctx, options = {}) {
  const file = handoffTokenFile(ctx)
  const sessionId = String(options.sessionId ?? 'default')
  const now = options.now ?? (() => new Date())
  const token = randomBytes(16).toString('hex')
  const store = await readTokenStore(file)
  const issuedAt = now().getTime()
  store[sessionId] = {
    token,
    issuedAt,
    expiresAt: issuedAt + HANDOFF_TOKEN_TTL_MS,
    used: false,
    ...(typeof options.reason === 'string' ? { reason: options.reason } : {}),
  }
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8').catch(async () => {
    // 目录可能不存在；建一次再写。
    await import('node:fs/promises').then(fs => fs.mkdir(dirname(file), { recursive: true }))
    await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
  })
  return { token, sessionId, issuedAt, expiresAt: issuedAt + HANDOFF_TOKEN_TTL_MS }
}

/**
 * 校验并**消费**令牌：验过就立刻作废（一次性）。
 *
 * 三道判据，缺一不可（顺序即优先级）：
 *   ① 本会话有记录     —— 没有 = 缺口令（跨会话拿别人的令牌也落这里）
 *   ② 没用过           —— 用过就作废（一次性）
 *   ③ 没过期           —— 超 TTL 或不带 `expiresAt`（旧格式）一律当过期，fail-safe
 *   ④ 值对得上
 *
 * @param {object} ctx
 * @param {{sessionId?: string, token?: string, now?: () => Date}} [options]
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function consumeHandoffToken(ctx, options = {}) {
  const file = handoffTokenFile(ctx)
  const sessionId = String(options.sessionId ?? 'default')
  const provided = String(options.token ?? '')
  const now = options.now ?? (() => new Date())
  const store = await readTokenStore(file)
  const record = store[sessionId]
  if (record === undefined) {
    return { ok: false, reason: '缺口令：本会话没有已发放的令牌。请项目主先说「任务收尾」' }
  }
  if (record.used === true) {
    return { ok: false, reason: '缺口令：该口令已用过（令牌一次性，用完即作废）' }
  }
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : null
  if (expiresAt === null || now().getTime() > expiresAt) {
    return {
      ok: false,
      reason: '缺口令：令牌已过期（有效期 '
        + `${Math.round(HANDOFF_TOKEN_TTL_MS / 60000)} 分钟，过期不复用）。`
        + '请项目主现在再喊一次「任务收尾」',
    }
  }
  if (provided === '' || provided !== record.token) {
    return { ok: false, reason: '缺口令：提供的令牌与会话记录不符' }
  }
  store[sessionId] = { ...record, used: true, usedAt: now().getTime() }
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8')
  return { ok: true }
}

// ── 本轮授权语（D0-1 的另一半：一句话 = 一次授权）─────────────────────
//
// 死锁：令牌过去只能由 `/limbs-handoff-token` 发，模型调不了 `ctx.commands`
// → 项目主说「任务收尾」后，模型还是拿不到令牌，只能人工收尾。
//
// 解法：给模型一个 `handoff_request_token`，但**发不发**不归模型决定 ——
// 它由「本轮 user message 里有没有授权语」判定。模型改不了 user message
// （它只能写 assistant / tool-call / tool-result），所以它没法自问自答。
//
// ── 三条判据（缺一即拒）────────────────────────────────────────────────
//
//   ① 只能看**本轮**：用 `ctx.agents.turnBoundaryOf(session).openTurnStartSeq`
//      取当前打开轮次的起点（官方 `dsh-tool-goal/authority.ts` 同一个用法），
//      只扫这之后的事件。上一轮说过「任务收尾」不代表这一轮还有授权。
//   ② 只能看**人**：`source.kind === 'user'` 不够。模块七自己注入的热层消息
//      也是 `kind: 'user'`（见 `createLocalUserMessage`），正文里还明写着
//      「要收尾请项目主说「任务收尾」」—— 拿正文当授权 = 热层自己授权自己。
//      官方 `'user-rpc'` 源是 `{ kind: 'user', rpcId, clientTimeZone?, principal? }`，
//      真正从界面打进来的人类输入**多一个 `rpcId`**；`schedule`（定时任务）、
//      `goal`（自动续轮）各用各的 kind，不是 `user`。所以判据是「kind=user 且有 rpcId」。
//   ③ 只能看**本次会话自己的**：fork / 子代理继承来的前缀里可能有人类原话，
//      拿它授权等于让子代理替项目主签字。所以跳过 `< inheritedEventCount` 的事件，
//      并直接拒绝 `header.origin === 'subagent'` 的会话。

/** 从消息内容里抽纯文本（只认 text 块）。 */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
}

/**
 * 人类输入的判据：`kind === 'user'` **且有** `rpcId`（官方 `'user-rpc'` 源）。
 *
 * @param {object} source 消息的 `source`
 * @returns {boolean}
 */
export function isHumanUserSource(source) {
  return source !== null && typeof source === 'object'
    && source.kind === 'user'
    && typeof source.rpcId === 'string'
    && source.rpcId !== ''
}

/**
 * 纯判定：这一轮的人类消息里有没有授权语。**不写盘、不发令牌**，好离线测。
 *
 * @param {object} input
 * @param {readonly object[]} input.events `session.snapshotEvents()` 的产物
 * @param {number|null} input.openTurnStartSeq 当前打开轮次的起点（null = 没有打开的轮次）
 * @param {number} [input.inheritedEventCount] fork 继承前缀的长度（这段不算）
 * @param {string} [input.origin] `session.header.origin`（`subagent` 直接拒）
 * @returns {{authorized: boolean, phrase: string|null, reason: string, humanMessages: number, scannedSeqFrom: number|null}}
 */
export function authorizationFromTurn(input) {
  const events = Array.isArray(input?.events) ? input.events : []
  const origin = input?.origin
  const inherited = Number.isFinite(input?.inheritedEventCount) ? Number(input.inheritedEventCount) : 0
  const base = {
    authorized: false,
    phrase: null,
    reason: '',
    humanMessages: 0,
    scannedSeqFrom: null,
  }

  if (origin === 'subagent') {
    return { ...base, reason: '缺口令：子代理不能替项目主授权收尾（父会话说了才算）' }
  }

  const turnStart = input?.openTurnStartSeq
  if (typeof turnStart !== 'number') {
    return { ...base, reason: '缺口令：本轮没有授权语句（当前没有打开的模型轮次，读不到本轮 user message）' }
  }

  const from = Math.max(turnStart, inherited)
  const humans = events.filter(event => event !== null && typeof event === 'object'
    && event.type === 'user/message'
    && typeof event.seq === 'number'
    && event.seq >= from
    && isHumanUserSource(event.data?.source))

  if (humans.length === 0) {
    return {
      ...base,
      scannedSeqFrom: from,
      reason: '缺口令：本轮没有授权语句（本轮没有任何「人类打进来」的 user message ——'
        + '热层注入、定时任务、自动续轮都不算人类输入）',
    }
  }

  for (const event of humans) {
    const phrase = matchAuthorizationPhrase(messageText(event.data?.content))
    if (phrase !== null) {
      return {
        authorized: true,
        phrase,
        reason: '',
        humanMessages: humans.length,
        scannedSeqFrom: from,
      }
    }
  }

  return {
    ...base,
    humanMessages: humans.length,
    scannedSeqFrom: from,
    reason: `缺口令：本轮没有授权语句（本轮 ${humans.length} 条人类消息里都没有`
      + `「${AUTHORIZATION_PHRASES.join('」「')}」这类口令）`,
  }
}

/**
 * 模型的令牌入口：**先验本轮授权语，验过才发**（一句话 = 一次授权）。
 *
 * @param {object} options
 * @param {object} options.ctx Host ctx（取 `agents` / `dshHomePath`）
 * @param {object} options.agent 调用方 agent（要 `session`）
 * @param {string} [options.sessionId] 记账键；缺省用当前会话真实 id（跨会话因此天然隔离）
 * @param {() => Date} [options.now]
 * @returns {Promise<{issued: boolean, reason: string, phrase?: string, token?: string, sessionId?: string, expiresAt?: number}>}
 */
export async function requestHandoffToken(options = {}) {
  const ctx = options.ctx
  const session = options.agent?.session
  if (session === undefined || session === null) {
    return { issued: false, reason: '缺口令：拿不到当前会话（工具不在 agent 上下文里），无法判定授权' }
  }

  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || agents === null || typeof agents.turnBoundaryOf !== 'function') {
    // 服务缺席 ≠ 有授权。按 fail-safe 处理：判不了本轮就不发。
    return { issued: false, reason: '缺口令：拿不到 agents 服务（无法读本轮边界），本次不发令牌（fail-safe）' }
  }

  let boundary
  try {
    boundary = agents.turnBoundaryOf(session)
  } catch (error) {
    return { issued: false, reason: `缺口令：读本轮边界失败（${error instanceof Error ? error.message : String(error)}）` }
  }

  let events
  try {
    // ⚠️ `snapshotEvents()` 官方标了 deprecated，但仍是对外公开的读口，官方插件自己在用
    // （`dsh-tool-goal/src/authority.ts` 与 `dsh-subagent/src/activation.ts` 都是这一行）。
    // 没有任何「本轮消息」的 Service 替代品；用它 + turnBoundaryOf 就是官方现有写法。
    events = session.snapshotEvents()
  } catch (error) {
    return { issued: false, reason: `缺口令：读会话事件失败（${error instanceof Error ? error.message : String(error)}）` }
  }

  const verdict = authorizationFromTurn({
    events,
    openTurnStartSeq: boundary?.openTurnStartSeq ?? null,
    inheritedEventCount: session.inheritedEventCount,
    origin: session.header?.origin,
  })
  if (!verdict.authorized) return { issued: false, reason: verdict.reason }

  const now = options.now ?? (() => new Date())
  const sessionId = String(options.sessionId ?? session.id ?? 'default')
  const issued = await issueHandoffToken(ctx, { sessionId, now, reason: verdict.phrase })
  return {
    issued: true,
    reason: '',
    phrase: verdict.phrase,
    token: issued.token,
    sessionId: issued.sessionId,
    expiresAt: issued.expiresAt,
    humanMessages: verdict.humanMessages,
  }
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
  //
  // ⚠️ 记账键必须与发令牌那边**同一个**。`handoff_request_token` 记在真实会话 id 上；
  // 这里若在没显式传 `sessionId` 时退回 `'default'`，就会出现「令牌发出去了、提交却说缺口令」
  // 的死锁假象（2026-11-25 真机就撞上了）。所以缺省取当前会话自己的 id。
  const tokenSessionId = options.sessionId ?? options.session?.header?.id ?? options.session?.id
  const tokenCheck = await consumeHandoffToken(options.ctx, {
    sessionId: tokenSessionId,
    token: options.token,
    now: () => now,
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
  // 文件名带内容摘要；拿不到 title 就抛 —— 真写更不许编（令牌都花了，不能留个空词）。
  const devlogName = devlogFileName(next.id, entry.title)
  const devlogPath = join(root, DEFAULT_DEVLOG_DIR, devlogName)
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
export const REQUEST_TOKEN_TOOL_NAME = 'handoff_request_token'

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
        session_id: {
          type: 'string',
          description: '令牌记账用；不给就用当前会话的真实 id（与 handoff_request_token 同一记账键，别乱填）。',
        },
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

  // 模型的令牌入口：**它能不能拿到令牌，不归它自己决定**。
  // 发不发由「本轮 user message 里有没有授权语」判定（见 authorizationFromTurn）。
  // 模型改不了 user message，所以「一句话 = 一次授权」在这里成立（D0-1）。
  disposers.push(ctx.tools.register({
    name: REQUEST_TOKEN_TOOL_NAME,
    description:
      '模块七 · 取一次性收尾令牌（D0-1）：只有**本轮**项目主自己打了「任务收尾」「收尾吧」这类口令才发。'
      + '发不发不归模型决定 —— 它只按本轮 user message 判定；没有口令一律拒并说明「缺口令」。'
      + '拿到的令牌只能用于一次 `handoff_commit`，30 分钟内有效，本会话外无效。',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '可选：记账键。不给就用当前会话的真实 id（跨会话因此天然隔离，别乱填）。',
        },
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const result = await requestHandoffToken({
        ctx,
        agent: exec?.agent,
        sessionId: typeof args?.session_id === 'string' ? args.session_id.trim() : undefined,
        now,
      })
      return renderTokenReport(result)
    },
  }))

  // 令牌发放入口（人）：项目主说「任务收尾」时跑一次，兜底用。
  // 模型那条走 `handoff_request_token`；这条永远可用，不依赖任何判定。
  if (typeof ctx.commands?.register === 'function') {
    disposers.push(ctx.commands.register({
      name: 'limbs-handoff-token',
      description: '模块七 · 发放一次性收尾令牌（D0-1，人工兜底）：说「任务收尾」后跑一次，令牌用掉即作废。',
      input: { hint: '[session_id] 记账键，默认 default' },
      handler: async invocation => {
        const sessionId = String(invocation.rawInput ?? '').trim() || 'default'
        try {
          const issued = await issueHandoffToken(ctx, { sessionId, now, reason: '由人执行 /limbs-handoff-token' })
          return {
            kind: 'success',
            text: `已发放一次性收尾令牌（session=${issued.sessionId}）：\n\n${issued.token}\n\n`
              + `有效期 ${Math.round(HANDOFF_TOKEN_TTL_MS / 60000)} 分钟，只能用于一次收尾，用掉即作废。`
              + '调用 `handoff_commit` 时把它作为 `token` 传入。',
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
 * 把令牌结果渲染成一段人可核的 markdown（发出去 / 拒掉都要能读懂）。
 *
 * @param {object} result `requestHandoffToken()` 的返回值
 * @returns {string}
 */
export function renderTokenReport(result) {
  if (result.issued !== true) {
    return [
      '# 模块七 · **没有发令牌**',
      '',
      result.reason,
      '',
      '## 为什么',
      '',
      '令牌 = 授权，而授权只能来自项目主本人。本工具只认**本轮**由人打进来的授权语'
        + `（${AUTHORIZATION_PHRASES.map(p => `「${p}」`).join('、')}）。`,
      '模型自己写的 assistant 文本、工具结果、热层注入、定时任务、自动续轮**都不算**人类输入 ——'
        + '所以模型没法给自己发令牌（D0-1）。',
      '',
      '## 怎么拿到',
      '',
      '- 请项目主在本轮消息里说一句「任务收尾」，再调一次本工具；或',
      '- 项目主执行 `/limbs-handoff-token`（人工兜底，与本工具同一套令牌）。',
      '',
    ].join('\n')
  }
  return [
    '# 模块七 · **已发放一次性令牌**',
    '',
    `- 判据：本轮人类消息里命中「${result.phrase}」`,
    `- 记账会话：\`${result.sessionId}\``,
    `- 有效期：${Math.round(HANDOFF_TOKEN_TTL_MS / 60000)} 分钟（过期作废）`,
    '',
    '```text',
    result.token,
    '```',
    '',
    '把它作为 `token` 传给 `handoff_commit`。**只够用一次**：扣掉令牌后还有权限档、项目配置、'
      + '写后自检三道闸，任何一道红了都不写盘。',
    '',
  ].join('\n')
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
    result.devlogPath === null
      ? '- 目标 devlog：**不生成**（账行未通过校验，摘要无从取得 —— 不编一个词糊过去）'
      : `- 目标 devlog：\`${result.devlogPath}\`${result.devlogExists ? '（⚠️ 已存在同名，真写时会拒写）' : '（同名不存在）'}`,
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
