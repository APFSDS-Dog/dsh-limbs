/**
 * 模块七 · 窗口交接 · 离线测试。
 *
 * 覆盖五层：
 *   1. 解析：账行（按位置认）、§3.3 待拍板、STATUS 快照与核对日期、devlog 四段；
 *   2. assemble：热层四段拼装 + `agent/pre-step` 的位次 / 首步空批挂 inbox / 只注一次；
 *   3. lookup：按 id 取冷存档正文、坏 id 与「账上有账没存档」的区分、关键词检索；
 *   4. commit dry-run：id 扫两处（devlog 文件名 + 账表）、六列校验、**断言没写盘**；
 *   5. 写盘段：令牌一次性 / U5 配置 / U6 权限档 / 真写 / 写后自检撤回（**全在副本里跑**）。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\handoff-test.mjs
 *
 * 只读：除了自己建的临时目录（退出时统一清理），不碰仓库里任何文件。
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_HANDOFF_CONFIG,
  DEVLOG_SECTIONS,
  LEDGER_COLUMNS,
  LEDGER_RECENT_LIMIT,
  LEDGER_STATUSES,
  assertWritablePolicy,
  commitHandoff,
  composeHotLayer,
  createHandoffAssembler,
  dateStamp,
  devlogFileName,
  dryRunCommit,
  issueHandoffToken,
  latestDevlogFile,
  lookupDevlog,
  nextTaskId,
  parseDevlogSections,
  parseHandoffYaml,
  parseLedgerRows,
  parsePendingDecisions,
  parseStatusCheckedAt,
  parseStatusSnapshot,
  readHandoffConfig,
  readHandoffInputs,
  renderDryRunReport,
  renderLedgerRow,
  renderLedgerWindow,
  resolveHandoffConfig,
  searchLedger,
  upsertLedgerRow,
  validateLedgerEntry,
} from '../lib/handoff.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ⚠️ 所有临时目录都登记在这里，退出时无条件清理。
// 曾经漏清理过：`dsh-limbs-empty-` 每跑一次漏一个、副本目录靠中途 `rm` 兜不住抛错。
// 改成「先登记、后使用」，不靠记得在哪一行 rm。
const TEMP_DIRS = []
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}
async function cleanupTempDirs() {
  for (const dir of TEMP_DIRS.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  }
}

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    process.stdout.write(`  PASS  ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`)
  }
}
const log = (line) => process.stdout.write(`${line}\n`)

// ═══════════════════════════════════════════════════════════════════════
log('== 1. 解析（账行按位置认，不按内容认）')
// ═══════════════════════════════════════════════════════════════════════

const progressText = await readFile(join(root, 'PROJECT_PROGRESS.md'), 'utf8')
const statusText = await readFile(join(root, 'PROJECT_STATUS.md'), 'utf8')

const rows = parseLedgerRows(progressText)
check('账行六列常量顺序即格式',
  JSON.stringify(LEDGER_COLUMNS) === JSON.stringify(['id', 'title', 'status', 'conclusion', 'archive', 'next']))
check('真实账表能解析出账行', rows.length >= 7, String(rows.length))
check('账行首格是 id 且形如 t-YYYYMMDD-NN',
  rows.every(row => /^t-\d{8}-\d{2}$/.test(row.id)),
  JSON.stringify(rows.map(row => row.id)))
check('账行状态只用四值',
  rows.every(row => LEDGER_STATUSES.includes(row.status)),
  JSON.stringify(rows.map(row => row.status)))
check('账行 id 不重复',
  new Set(rows.map(row => row.id)).size === rows.length)

// 坏 id 必须被抓到 —— 这正是 MODULE7 §八#2 那个假阴性。
const badLedger = [
  '| id | 标题 | 状态 | 结论 | 存档 | next |',
  '|---|---|---|---|---|---|',
  '| `task-1` | 坏 id | `doing` | 该被抓到 | — | 继续 |',
  '| 没有反引号 | 不算账行 | `doing` | 不该被抓 | — | — |',
  '| `t-20260101-01` | 少列 | `done` | 列数不足 | — |',
].join('\n')
const badRows = parseLedgerRows(badLedger)
check('坏 id「task-1」不会整行漏检', badRows.length === 1 && badRows[0].id === 'task-1',
  JSON.stringify(badRows.map(row => row.id)))
check('无反引号的行不算账行（按位置认）', !badRows.some(row => row.title === '不算账行'))
check('列数不足六列的行不算账行', !badRows.some(row => row.id === 't-20260101-01'))

const decisions = parsePendingDecisions(progressText)
// ⚠️ 不写死具体编号：待拍板会随拍板而增减（本任务就把 Q1/Q4 拍掉了）。
// 真正要守的是「待拍板段能取到、且与已拍板段不串」。
check('§3.3 待拍板段能取到',
  typeof decisions.pending === 'string' && decisions.pending.length > 0,
  decisions.pending.slice(0, 60))
check('§3.3 待拍板段不含已拍板的条目',
  !/\|\s*Q2\s*\|/.test(decisions.pending), decisions.pending.slice(0, 120))
check('§3.3 已拍板单独取出且只读',
  decisions.decided.includes('Q2') && !decisions.pending.includes('| Q2 |'))

const snapshot = parseStatusSnapshot(statusText)
check('STATUS §二 快照取到表', snapshot.includes('| 项 |') && snapshot.includes('| 实测值 |'))
check('快照带核对日期', parseStatusCheckedAt(statusText) !== null,
  String(parseStatusCheckedAt(statusText)))
check('快照不含 §三 的内容（切在下一个二级标题）', !snapshot.includes('目录职责'))

const sampleDevlogText = await readFile(join(root, 'Docs/devlog/t-20261120-02_开发交接.md'), 'utf8')
const sampleSections = parseDevlogSections(sampleDevlogText)
check('devlog 四段键齐全（英文键）',
  JSON.stringify(Object.keys(sampleSections)) === JSON.stringify(DEVLOG_SECTIONS),
  JSON.stringify(Object.keys(sampleSections)))
check('样本四段都有正文',
  DEVLOG_SECTIONS.every(key => typeof sampleSections[key] === 'string' && sampleSections[key].length > 0))
check('goal 段不串到 confirmed_facts',
  !sampleSections.goal.includes('##') && sampleSections.confirmed_facts.startsWith('**起点'),
  sampleSections.confirmed_facts.slice(0, 30))

const latest = await latestDevlogFile(join(root, 'Docs/devlog'))
// ⚠️ 不写死具体文件名：本任务自己就会产出 devlog，写死等于「测试跟着代码一起改」。
// 真正要守的是「取到的是 id 最大的那一份」—— 用目录实际内容算一遍对照。
const allDevlogs = (await readdir(join(root, 'Docs/devlog')))
  .filter(name => /^t-\d{8}-\d{2}_.*\.md$/.test(name))
  .sort()
check('取 id 最大的 devlog（字典序 = 时间序）',
  latest === allDevlogs[allDevlogs.length - 1] && /^t-\d{8}-\d{2}_/.test(String(latest)),
  `latest=${latest} · 目录最大=${allDevlogs[allDevlogs.length - 1]}`)

check('dateStamp 用本地日期', dateStamp(new Date(2026, 10, 21)) === '20261121',
  dateStamp(new Date(2026, 10, 21)))
check('devlog 文件名照 D3 命名', devlogFileName('t-20261121-01') === 't-20261121-01_开发交接.md')

// ═══════════════════════════════════════════════════════════════════════
log('== 2. assemble：热层四段')
// ═══════════════════════════════════════════════════════════════════════

const inputs = await readHandoffInputs(root)
const packed = composeHotLayer(inputs)

check('四段标题齐全', ['## 一、任务账', '## 二、待拍板', '## 三、实测状态快照', '## 四、上一次交接']
  .every(heading => packed.includes(heading)))
check('第 1 段是账表滑窗、不超过 10 行',
  renderLedgerWindow(inputs.ledgerRows).split('\n').length
    === 2 + Math.min(10, inputs.ledgerRows.length),
  String(renderLedgerWindow(inputs.ledgerRows).split('\n').length))
check('第 1 段渲染出真实 id', packed.includes('`t-20261120-02`'))
check('第 2 段是待拍板且不剪',
  packed.includes('## 二、待拍板')
  && (inputs.pending === '' || packed.includes(inputs.pending.trim().slice(0, 10))))
check('第 3 段带核对日期', /核对日期 \d{4}-\d{2}-\d{2}/.test(packed), packed.match(/核对日期[^\n]{0,20}/)?.[0])
check('第 4 段取自最新 devlog 且注明来源',
  packed.includes(String(inputs.latestDevlog))
  && typeof inputs.latestDevlogSections?.todos === 'string'
  && packed.includes(inputs.latestDevlogSections.todos.slice(0, 12)),
  `来源=${inputs.latestDevlog}`)
check('不注入 AGENTS.md 契约（红线/协作不该出现）',
  !packed.includes('单一数据源') && !packed.includes('不代提交'), '')
check('拼装体量在 1.5~12KB 量级', packed.length > 1500 && packed.length < 12000, `${packed.length} 字符`)

log('')
log('──────────────────── 拼装结果（供人核对）────────────────────')
log(packed)
log('──────────────────── 拼装结束 ────────────────────────────────')
log('')

// 空工程的退化输出：不该炸，也不该编造。
const emptyPacked = composeHotLayer({
  ledgerRows: [], pending: '', statusSnapshot: '', statusCheckedAt: null,
  latestDevlog: null, latestDevlogSections: null,
})
check('空工程也能拼出四段（占位说明而非空白）',
  emptyPacked.includes('账表为空') && emptyPacked.includes('无待拍板条目') && emptyPacked.includes('未取到'))

// ── pre-step 语义：位次 / 首步空批挂 inbox / 只注一次 ──────────────────
const fakeCompose = async () => '哈喽，这是注入的热层。'

// (a) 首步 + decision.messages 为空 → 挂 inbox，不占轮
{
  const { listener, stats } = createHandoffAssembler({ compose: fakeCompose })
  const prepended = []
  const agent = {
    session: { header: { cwd: root } },
    inbox: { prepend: (target, message) => prepended.push({ target, message }) },
  }
  const claimed = []
  const decision = await listener(
    { agent, messages: claimed, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  check('首步空批不占轮：decision 原样返回', decision.kind === 'enter' && decision.messages.length === 0)
  check('首步空批把上下文挂到 inbox next-step',
    prepended.length === 1 && prepended[0].target === 'next-step',
    JSON.stringify(prepended.map(item => item.target)))
  check('挂进 inbox 的是 user 角色消息',
    prepended[0]?.message?.role === 'user'
    && prepended[0]?.message?.content?.[0]?.text.includes('热层'))
  check('计数记为 deferred', stats.deferred === 1 && stats.injected === 0, JSON.stringify(stats))

  // 同一个 agent 再来一步：不再注入（§8.2 只注一次）
  const again = await listener(
    { agent, messages: claimed, step: 2, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  check('同一 agent 第二步不再注入', again.messages.length === 0 && stats.skipped === 1,
    JSON.stringify(stats))
}

// (b) 已有用户提问 → 插在提问之后（最后一个「本批已认领」的后面）
{
  const { listener, stats } = createHandoffAssembler({ compose: fakeCompose })
  const agent = { session: { header: { cwd: root } }, inbox: { prepend: () => {} } }
  const userMessage = { id: 'm-user', role: 'user', content: [{ type: 'text', text: '接着做模块七' }] }
  const runtimeContext = { id: 'm-runtime', role: 'user', content: [{ type: 'text', text: 'runtime ctx' }] }
  const claimed = [userMessage]
  const decision = await listener(
    { agent, messages: claimed, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [userMessage, runtimeContext] }),
  )
  check('注入点紧跟用户提问之后、runtime context 之前',
    decision.messages.length === 3
    && decision.messages[0].id === 'm-user'
    && decision.messages[1].role === 'user'
    && decision.messages[1].content[0].text.includes('热层')
    && decision.messages[2].id === 'm-runtime',
    JSON.stringify(decision.messages.map(message => message.id ?? 'injected')))
  check('已有提问时计入 injected', stats.injected === 1 && stats.deferred === 0, JSON.stringify(stats))
  check('注入的消息带稳定 id',
    typeof decision.messages[1].id === 'string' && decision.messages[1].id.length > 0)
}

// (c) reject 不注入
{
  const { listener, stats } = createHandoffAssembler({ compose: fakeCompose })
  const agent = { session: { header: { cwd: root } }, inbox: { prepend: () => {} } }
  const decision = await listener(
    { agent, messages: [], step: 1, signal: undefined },
    async () => ({ kind: 'reject' }),
  )
  check('reject 时保持 reject 不改写', decision.kind === 'reject')
  check('reject 计入 deferred（挂 inbox 等下一轮）', stats.deferred === 1, JSON.stringify(stats))
}

// (d) 没有 cwd 的项目 → 一律不注入（串话防线）
{
  const { listener, stats } = createHandoffAssembler({ compose: fakeCompose })
  const agent = { session: { header: {} }, inbox: { prepend: () => {} } }
  const decision = await listener(
    { agent, messages: [], step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  check('cwd 缺失时不注入（防串话）', decision.messages.length === 0 && stats.skipped === 1,
    JSON.stringify(stats))
}

// (e) compose 抛错不阻断用户那一轮
{
  const { listener, stats } = createHandoffAssembler({
    compose: async () => { throw new Error('boom') },
  })
  const agent = { session: { header: { cwd: root } }, inbox: { prepend: () => {} } }
  const decision = await listener(
    { agent, messages: [], step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  check('装配失败静默降级，不阻断本轮', decision.kind === 'enter' && stats.skipped === 1,
    JSON.stringify(stats))
}

// ═══════════════════════════════════════════════════════════════════════
log('== 3. lookup：按 id 取冷存档、按关键词检索账表')
// ═══════════════════════════════════════════════════════════════════════

const found = await lookupDevlog('t-20261120-02', root)
check('按 id 取到 t-20261120-02 的正文', found.found && found.text.includes('v0.2 半成品分批入库'))
check('正文含四段', DEVLOG_SECTIONS.every(key => found.text.includes(`## ${key}`)))
check('返回真实路径', String(found.path).endsWith(join('Docs', 'devlog', 't-20261120-02_开发交接.md')),
  String(found.path))

const malformed = await lookupDevlog('20261120-02', root)
check('坏 id 明说格式不对（不假装找不到）',
  !malformed.found && malformed.reason.includes('t-YYYYMMDD-NN'), malformed.reason)

const missingId = await lookupDevlog('t-20200101-09', root)
check('不存在的 id 明说账表与存档都没有',
  !missingId.found && missingId.reason.includes('都没有'), missingId.reason)

const searched = await searchLedger('模块七', root)
check('关键词命中账表', searched.matches.length >= 1, String(searched.matches.length))
check('命中的是模块七那一行', searched.matches.every(row => row.title.includes('模块七')))
check('空关键词返回空集', (await searchLedger('   ', root)).matches.length === 0)

// ═══════════════════════════════════════════════════════════════════════
log('== 4. commit dry-run：id 扫两处、不写盘')
// ═══════════════════════════════════════════════════════════════════════

const realNext = await nextTaskId({ projectRoot: root, now: new Date(2026, 10, 21) })
check('当天无记录时从 01 起',
  (await nextTaskId({ projectRoot: await tempDir('dsh-limbs-empty-'), now: new Date(2026, 10, 21) })).id
  === 't-20261121-01')
check('真实工程算出的 id 是当天首个', /^t-20261121-\d{2}$/.test(realNext.id), realNext.id)

// 关键：**账表里有、devlog 里没有** 的 id 也要算进去（否则必撞号）
const probeRoot = await tempDir('dsh-limbs-commit-')
await mkdir(join(probeRoot, 'Docs', 'devlog'), { recursive: true })
await writeFile(join(probeRoot, 'Docs', 'devlog', 't-20261121-01_开发交接.md'), '# 假的\n', 'utf8')
await writeFile(join(probeRoot, 'Docs', 'devlog', 't-20261121-02_开发交接.md'), '# 假的\n', 'utf8')
await writeFile(join(probeRoot, 'PROJECT_PROGRESS.md'), [
  '# 项目进度',
  '',
  '| id | 标题 | 状态 | 结论 | 存档 | next |',
  '|---|---|---|---|---|---|',
  '| `t-20261121-03` | 账上未开工 | `doing` | 只存在于账本 | — | 先做 |',
  '| `t-20261121-05` | 账上跳号 | `doing` | 账本里已到 05 | — | 先做 |',
  '| `t-20261120-99` | 昨天的不算 | `done` | 不参与今天 | `t-20261120-99` | — |',
].join('\n'), 'utf8')

const collided = await nextTaskId({ projectRoot: probeRoot, now: new Date(2026, 10, 21) })
check('id 取「devlog 文件名」与「账表 id」两处的最大 +1',
  collided.id === 't-20261121-06', JSON.stringify(collided))
check('两处各自的最大值都报出来（可核）',
  collided.fromDevlog === 2 && collided.fromLedger === 5, JSON.stringify(collided))
check('只看 devlog 会撞号（05 在账上、devlog 只到 02）',
  collided.id !== 't-20261121-03' && collided.id !== 't-20261121-04')

// 校验：六列 / 四值 / 长度
check('合格条目通过校验', validateLedgerEntry({
  title: '模块七 窗口交接', status: 'doing', conclusion: '只读两段跑通', next: '明早决策写盘',
}).ok)
const tooLong = validateLedgerEntry({
  title: '一二三四五六七八九十一二三四五六', status: 'doing', conclusion: '短', next: '—',
})
check('标题超 15 字被拒', !tooLong.ok && tooLong.problems.some(p => p.includes('title 超')))
check('状态非四值被拒',
  !validateLedgerEntry({ title: 'x', status: 'finished', conclusion: 'y', next: '—' }).ok)
check('缺 next 被拒', !validateLedgerEntry({ title: 'x', status: 'done', conclusion: 'y', next: '' }).ok)

const row = renderLedgerRow('t-20261121-01', {
  title: '模块七 窗口交接', status: 'doing', conclusion: '只读两段跑通', next: '明早决策写盘',
})
check('账行渲染成六列', row.split('|').filter(cell => cell.trim() !== '').length === 6
  && row.startsWith('| `t-20261121-01` |') && row.endsWith(' |'), row)

// ⚠️ 回归断言：这里曾经写错过。`存档` 列的判据是「**有没有 devlog**」，
// 不是「状态是不是 done」——真机首跑就撞上：`doing` 的子任务写了 devlog，账行却标 `—`。
// 原断言写的是「doing 就该标 —」，等于把 bug 钉进了测试。见 t-20261121-03 todos 第 1 条。
check('子任务有 devlog → 存档列写 id（doing 也一样）',
  row.includes('| `t-20261121-01` | 明早决策写盘 |'), row)
check('模块级父任务（无 devlog）→ 存档列写 —',
  renderLedgerRow('t-20261120-01', {
    title: '模块七 窗口交接', status: 'doing', conclusion: '真机真写成功', next: '看子任务',
  }, { hasDevlog: false }).includes('| — |'))

const dry = await dryRunCommit({
  projectRoot: probeRoot,
  now: new Date(2026, 10, 21),
  entry: {
    title: '模块七 窗口交接',
    status: 'doing',
    conclusion: '只读两段跑通',
    next: '明早决策写盘',
    sections: {
      goal: '把 assemble 与 lookup 跑通。',
      confirmed_facts: '- 离线测试全过',
      excluded_paths: '- 没走 systemPrompt.section()',
      todos: '1. 明早决定是否打开真写',
    },
  },
})
check('dry-run 明确标了 dryRun 且 wrote=false', dry.dryRun === true && dry.wrote === false)
check('dry-run 算出 id', dry.id === 't-20261121-06', dry.id)
check('dry-run 拼出账行', typeof dry.ledgerRow === 'string' && dry.ledgerRow.includes(dry.id))
check('dry-run 拼出 devlog 正文四段',
  DEVLOG_SECTIONS.every(key => dry.devlogBody.includes(`## ${key}`)))
check('dry-run 指向的目标 devlog 尚不存在', dry.devlogExists === false, String(dry.devlogExists))
check('dry-run 明说哪些还没实现（口令 / 写盘 / 自检）',
  dry.notYetImplemented.length >= 3 && dry.notYetImplemented.some(item => item.includes('写盘')))

const report = renderDryRunReport(dry)
check('报告开头就说明没写文件', report.includes('没有写任何文件'))
check('报告打印了账行与 devlog 正文',
  report.includes('要追加的账行') && report.includes('要写入的 devlog 正文'))

log('')
log('──────────────────── dry-run 报告（供人核对）────────────────────')
log(report)
log('──────────────────── 报告结束 ────────────────────────────────')
log('')

// 真没写盘：dry-run 跑完后临时目录里只有我们预置的三份文件
// （两份假 devlog + 一份账表），一个不多一个不少。
const PREPARED_FILES = 3
async function listFiles(dir) {
  const out = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full.replace(dir, '').replaceAll('\\', '/'))
    }
  }
  await walk(dir)
  return out.sort()
}
const afterFiles = await listFiles(probeRoot)
check('dry-run 后工程文件一个没多（真没落盘）',
  afterFiles.length === PREPARED_FILES, JSON.stringify(afterFiles))
check('没有生成新 id 的 devlog',
  !afterFiles.some(name => name.includes('t-20261121-06')))
check('账表文件没被改写',
  (await readFile(join(probeRoot, 'PROJECT_PROGRESS.md'), 'utf8')).includes('账上跳号'))

// ═══════════════════════════════════════════════════════════════════════
log('== 5. 写盘段：令牌 / 配置 / 权限 / 真写 / 自检撤回（副本验证）')
// ═══════════════════════════════════════════════════════════════════════
//
// ⚠️ **绝不在真仓库做真写**。这里把仓库复制到临时副本，
// 在副本里跑全流程；跑完删掉副本。真仓库的 Docs/ 与账表一个字节都不动。

/** 递归复制我们要的子树（Docs/ + lib/ + 几份根文件）。 */
async function copyProject(destination) {
  const copyTree = async (relative) => {
    const from = join(root, relative)
    const to = join(destination, relative)
    let entries
    try { entries = await readdir(from, { withFileTypes: true }) } catch { return }
    await mkdir(to, { recursive: true })
    for (const entry of entries) {
      if (entry.name === '__pycache__') continue
      if (entry.isDirectory()) {
        await copyTree(join(relative, entry.name))
        continue
      }
      await copyFile(join(from, entry.name), join(to, entry.name))
    }
  }
  for (const item of ['Docs', 'lib']) await copyTree(item)
  for (const file of ['PROJECT_PROGRESS.md', 'PROJECT_STATUS.md', 'DOCS_LAYOUT.md',
    'AGENTS.md', 'ARCHITECTURE.md', 'README.md', 'check_docs.py', 'check-docs.ps1']) {
    try { await copyFile(join(root, file), join(destination, file)) } catch { /* 缺了就算了 */ }
  }
  return destination
}

const cloneRoot = await copyProject(await tempDir('dsh-limbs-clone-'))
const cloneProgress = join(cloneRoot, 'PROJECT_PROGRESS.md')
const cloneDevlogDir = join(cloneRoot, 'Docs', 'devlog')
const cloneOriginalProgress = await readFile(cloneProgress, 'utf8')
const cloneDevlogsBefore = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()

const CLONE_ENTRY = {
  title: '副本写盘验证',
  status: 'doing',
  conclusion: '副本里跑通真写与撤回',
  next: '删副本',
  sections: {
    goal: '在副本里验证写盘段全流程。',
    confirmed_facts: '- 这是副本，不影响真仓库。',
    excluded_paths: '- 不在真仓库做真写测试。',
    todos: '1. 删掉副本。',
  },
}

/** 造一个假的 Host ctx（令牌走临时 DSH_HOME，权限档可控）。 */
function makeFakeHostCtx({ mode = 'workspace-write', home }) {
  return {
    get: (name) => {
      if (name === 'dshHomePath') {
        return (...parts) => join(home, ...parts)
      }
      if (name === 'sandboxPolicy') {
        return { resolve: () => ({ mode, workspaceRoot: undefined }) }
      }
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
  }
}

const tokenHome = await tempDir('dsh-limbs-tokenhome-')
const hostCtx = makeFakeHostCtx({ home: tokenHome })

// ── 断言 ①：无令牌时一个文件都不写 ──────────────────────────────────
{
  const refused = await commitHandoff({
    ctx: hostCtx, projectRoot: cloneRoot, force: true, entry: CLONE_ENTRY,
  })
  const after = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()
  check('① 无令牌被拒（refusedAt=token）', refused.wrote === false && refused.refusedAt === 'token',
    JSON.stringify({ wrote: refused.wrote, at: refused.refusedAt }))
  check('① 拒绝理由明说「缺口令」', String(refused.reason).includes('缺口令'), refused.reason)
  check('① 无令牌时 devlog 一个没多',
    after.length === cloneDevlogsBefore.length && after.join() === cloneDevlogsBefore.join())
  check('① 无令牌时账表没被改',
    (await readFile(cloneProgress, 'utf8')) === cloneOriginalProgress)
}

// ── 配置：write: true（只在副本里开）────────────────────────────────
await mkdir(join(cloneRoot, '.dsh'), { recursive: true })
await writeFile(join(cloneRoot, '.dsh', 'handoff.yaml'), 'write: true\nledgerRecent: 7\n', 'utf8')
{
  const configRead = await readHandoffConfig(cloneRoot)
  check('U5 配置能从 .dsh/handoff.yaml 读到', configRead.found && configRead.config.write === true,
    JSON.stringify(configRead.config))
  check('U5 配置项被采纳（ledgerRecent=7）', configRead.config.ledgerRecent === 7)
}

// ── 断言 ③（先跑）：自检红 → 撤回；断言 ②：令牌一次性 ────────────────
{
  const issued = await issueHandoffToken(hostCtx, { sessionId: 'clone' })

  // 制造自检红：用 U5 的 `checkCommand` 注入一个**必定失败**的命令。
  // ⚠️ 不靠「往账表塞坏行」—— check_docs.py 对六列以下的行是 `continue` 跳过而非报错，
  // 那正是它刻意的口径（§八#2：不能靠内容认）。这里用配置注入，确定性最强，
  // 且顺带验证「配置指定的自检命令确实被采纳」。
  await writeFile(join(cloneRoot, '.dsh', 'handoff.yaml'),
    'write: true\ncheckCommand: pwsh -NoProfile -Command "exit 1"\n', 'utf8')
  const redRun = await commitHandoff({
    ctx: hostCtx, projectRoot: cloneRoot, sessionId: 'clone', token: issued.token,
    force: true, entry: { ...CLONE_ENTRY, title: '自检红撤回' },
  })
  const afterRed = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()
  check('③ 自检报红 → 写入被撤回（wrote=false、refusedAt=self-check）',
    redRun.wrote === false && redRun.refusedAt === 'self-check',
    JSON.stringify({ wrote: redRun.wrote, at: redRun.refusedAt, reason: redRun.reason }))
  check('③ 撤回后 devlog 被删掉（没有半截）',
    afterRed.length === cloneDevlogsBefore.length, JSON.stringify(afterRed))
  check('③ 撤回后账表恢复到「写入前」的原文',
    redRun.rolledBack === true && (await readFile(cloneProgress, 'utf8')) === cloneOriginalProgress,
    String(redRun.rolledBack))
  check('③ 拒绝理由写明已撤回', String(redRun.reason).includes('撤回'), redRun.reason)
  check('③ 自检真的跑了且非零（配置的 checkCommand 被采纳）',
    typeof redRun.check?.code === 'number' && redRun.check.code !== 0 && redRun.check.ok === false,
    JSON.stringify({ code: redRun.check?.code, ok: redRun.check?.ok }))

  // 令牌已被上面那次消费掉 —— 正好验「一次性」
  const reuse = await commitHandoff({
    ctx: hostCtx, projectRoot: cloneRoot, sessionId: 'clone', token: issued.token,
    force: true, entry: CLONE_ENTRY,
  })
  check('② 令牌第二次使用被拒（一次性）',
    reuse.wrote === false && reuse.refusedAt === 'token', JSON.stringify(reuse.refusedAt))
  check('② 拒绝理由说明「已用过」', String(reuse.reason).includes('已用过'), reuse.reason)

  // 配置改回自动探测，重新发令牌，跑真写全流程
  await writeFile(join(cloneRoot, '.dsh', 'handoff.yaml'), 'write: true\nledgerRecent: 7\n', 'utf8')
  const issued2 = await issueHandoffToken(hostCtx, { sessionId: 'clone' })
  const greenRun = await commitHandoff({
    ctx: hostCtx, projectRoot: cloneRoot, sessionId: 'clone', token: issued2.token,
    force: true, entry: CLONE_ENTRY,
  })
  check('真写成功（wrote=true）', greenRun.wrote === true, JSON.stringify(greenRun.reason))
  check('真写后自检通过', greenRun.check?.ok === true, JSON.stringify(greenRun.check?.code))

  const afterGreen = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()
  check('devlog 真的出现了', afterGreen.length === cloneDevlogsBefore.length + 1,
    JSON.stringify(afterGreen))
  const newId = greenRun.id
  const newFile = afterGreen.find(name => name.startsWith(newId + '_'))
  check('devlog 文件名带算出的 id', newFile !== undefined, String(newFile))

  const written = await readFile(join(cloneDevlogDir, newFile), 'utf8')
  check('devlog 四段齐全（模板写对）',
    DEVLOG_SECTIONS.every(key => written.includes(`## ${key}`)))
  check('devlog 标题含 id 与标题', written.startsWith(`# ${newId} · ${CLONE_ENTRY.title}`))

  const afterProgress = await readFile(cloneProgress, 'utf8')
  check('账行被追加进账表', afterProgress.includes(newId) && afterProgress !== cloneOriginalProgress)
  check('账行没撞号（原文里没有同 id 的账行）',
    !parseLedgerRows(cloneOriginalProgress).some(row => row.id === newId), newId)
  check('账行插在账表分组内（不是文件末尾乱插）',
    afterProgress.indexOf(newId) > afterProgress.indexOf('### v0.2'))
  check('写后账表仍能解析出合法账行',
    parseLedgerRows(afterProgress).filter(row => row.id === newId).length === 1)
}

// ── 断言 ④：dry-run 仍然不写 ───────────────────────────────────────
{
  const before = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()
  const progressBefore = await readFile(cloneProgress, 'utf8')
  const dryAgain = await dryRunCommit({ projectRoot: cloneRoot, entry: CLONE_ENTRY })
  const after = (await readdir(cloneDevlogDir)).filter(n => n.startsWith('t-')).sort()
  check('④ dry-run 仍标 dryRun 且 wrote=false',
    dryAgain.dryRun === true && dryAgain.wrote === false)
  check('④ dry-run 后 devlog 数量不变', after.length === before.length)
  check('④ dry-run 后账表一字未改',
    (await readFile(cloneProgress, 'utf8')) === progressBefore)
}

// ── U5：默认值与坏值收敛 ────────────────────────────────────────────
{
  check('U5 默认配置 write=false（真写默认关）', DEFAULT_HANDOFF_CONFIG.write === false)
  check('U5 缺失配置文件不报错、回退默认',
    (await readHandoffConfig(join(cloneRoot, 'Docs'))).found === false)
  const parsed = parseHandoffYaml('# 注释\nwrite: true\ncheckCommand: "pwsh -File x.ps1"\nledgerRecent: 3\n')
  check('U5 YAML 极简解析能认布尔/引号/数字',
    parsed.write === true && parsed.checkCommand === 'pwsh -File x.ps1' && parsed.ledgerRecent === 3,
    JSON.stringify(parsed))
  const bad = resolveHandoffConfig({ write: 'yes please', ledgerRecent: 999, unknown: 1 })
  check('U5 坏值逐条回退并留 warnings',
    bad.config.write === false && bad.config.ledgerRecent === LEDGER_RECENT_LIMIT
    && bad.warnings.length === 3, JSON.stringify(bad.warnings))
}

// ── U6：read-only 显式报错，不静默 ──────────────────────────────────
{
  const readOnlyCtx = makeFakeHostCtx({ mode: 'read-only', home: tokenHome })
  const issued3 = await issueHandoffToken(readOnlyCtx, { sessionId: 'ro' })
  const refused = await commitHandoff({
    ctx: readOnlyCtx, projectRoot: cloneRoot, sessionId: 'ro', token: issued3.token,
    force: true, entry: CLONE_ENTRY,
  })
  check('U6 read-only 时拒写（refusedAt=sandbox）',
    refused.wrote === false && refused.refusedAt === 'sandbox', JSON.stringify(refused.refusedAt))
  check('U6 报错明说「只读」', String(refused.reason).includes('只读'), refused.reason)

  let threw = null
  try {
    assertWritablePolicy({ get: () => undefined })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('U6 拿不到 sandboxPolicy 服务时 fail-safe 抛错',
    threw !== null && threw.includes('无法确认工作区可写'), String(threw))
}

// ── upsert：同 id 走替换分支而不是新增一行 ──────────────────────────
{
  const once = upsertLedgerRow(
    cloneOriginalProgress, '| `t-20261121-77` | 新行 | `doing` | 结论 | — | — |', 't-20261121-77')
  const twice = upsertLedgerRow(
    once.markdown, '| `t-20261121-77` | 改过的行 | `done` | 结论 | — | — |', 't-20261121-77')
  check('upsert 首次是 inserted', once.action === 'inserted')
  check('upsert 同 id 第二次是 replaced（不多一行）', twice.action === 'replaced')
  check('upsert 替换后该 id 只出现一次',
    parseLedgerRows(twice.markdown).filter(row => row.id === 't-20261121-77').length === 1)
  check('upsert 替换后是改过的内容', twice.markdown.includes('改过的行'))
}

// ── 真仓库必须没被本次测试碰过 ──────────────────────────────────────
check('真仓库账表仍是我手写的版本（没做真写测试）',
  (await readFile(join(root, 'PROJECT_PROGRESS.md'), 'utf8')).includes('.dev 纳入版本控制'))

// `.dsh/handoff.yaml` 现在**存在**（真机已开真写，见 t-20261121-03），
// 所以不能断言「文件不存在」。真正要守的是：它**不入 git**。
// 理由：`write: true` 入库 = 默认允许真写，别人 clone 下来直接能改台账。
check('项目配置存在时也不入 git（write: true 不能被共享）',
  await readFile(join(root, '.dsh', 'handoff.yaml'), 'utf8')
    .then(async () => {
      // 用 Node 自己判：git check-ignore 需要 git，但这里能拿到 .gitignore 的真源。
      const ignore = await readFile(join(root, '.gitignore'), 'utf8')
      return /^\/?\.dsh\/handoff\.yaml\s*$/m.test(ignore)
    }, () => true))

// 仓库本体也必须没被碰过：关键三份的 mtime 不比测试开始前新。
const devlogDirStat = await stat(join(root, 'Docs', 'devlog'))
check('仓库 Docs/devlog 仍是目录', devlogDirStat.isDirectory())

await cleanupTempDirs()
// ⚠️ 只核「本次登记过的」目录 —— tmpdir 里可能还躺着别的进程/历史遗留目录，
// 拿它做全局断言会假红（本次就跑出过这条假红）。
check('本次创建的临时目录已全部清理（含副本）', TEMP_DIRS.length === 0,
  `残留登记项 ${TEMP_DIRS.length}`)

log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
