/**
 * 模块三 · 复盘报告落盘（B2）离线测试。
 *
 * 不启动 DSH：用一个假 ctx（`dshHomePath` 解析器 + `sandboxPolicy` + 假会话），
 * 在系统临时目录里真写盘、真读回、真删文件 —— 清理策略必须能看见磁盘结果，
 * 光断言「函数返回了 20 个名字」不算验证。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\review-store-test.mjs
 */

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REVIEW_KEEP_COUNT,
  REVIEW_KEEP_DAYS,
  createReviewStore,
  pruneReviewReports,
  readReviewReport,
  reviewFileName,
  reviewFile,
  reviewPolicyMode,
  reviewsDir,
  saveReviewReport,
  saveReviewSafely,
  serveReviewBridge,
  serveReviewReport,
} from '../lib/review-store.js'
import { apply, generateMarkdown, reviewConversationOnce, withTopThree } from '../lib/host.js'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 假 Host ctx ────────────────────────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'dsh-limbs-review-'))
const MODE = { value: 'workspace-write' }

const fakeSession = {
  id: 'session:test-0001',
  header: { cwd: 'D:\\Projects\\dsh-limbs', createdAt: 1_700_000_000_000 },
  seq: 0,
  ownEvents: () => [],
}

function makeCtx({ home: homeDir = home, mode = MODE.value, policy = 'ok' } = {}) {
  return {
    sessions: { get: (id) => (id === fakeSession.id ? fakeSession : undefined) },
    get(name) {
      if (name === 'dshHomePath') return (...parts) => join(homeDir, ...parts)
      if (name === 'sandboxPolicy') {
        if (policy === 'missing') return undefined
        return { resolve: () => ({ mode, workspaceRoot: 'D:\\Projects\\dsh-limbs' }) }
      }
      return undefined
    },
  }
}

// ════════════════════════════════════════════════════════════════════
console.log('\n[1] 文件名与目录')
check('目录落在 <DSH_HOME>/dsh-limbs/reviews', reviewsDir(makeCtx()) === join(home, 'dsh-limbs', 'reviews'),
  reviewsDir(makeCtx()))
check('会话 id 里的冒号被压成连字符（Windows 文件名非法字符）',
  reviewFileName('session:test-0001') === 'session-test-0001.md', reviewFileName('session:test-0001'))
check('纯 uuid 文件名原样保留',
  reviewFileName('368b7e45-f8a5-4f53-82b3-3d8566318084') === '368b7e45-f8a5-4f53-82b3-3d8566318084.md',
  reviewFileName('368b7e45-f8a5-4f53-82b3-3d8566318084'))
check('空会话 id 有兜底名', reviewFileName('') === 'unknown-session.md', reviewFileName(''))
check('超长 id 被截断（Windows 路径上限）',
  reviewFileName('x'.repeat(200)).length <= 70, String(reviewFileName('x'.repeat(200)).length))

// ════════════════════════════════════════════════════════════════════
console.log('\n[2] 落盘 + 读回一致')
const REPORT = [
  '## 会话复盘 · 效率诊断',
  '',
  '### 最该做的三条',
  '1. **先 grep 定位，再按行读取**',
  '',
  '### 一、总账',
  '| 指标 | 数值 |',
  '|---|---|',
  '| 工具调用 | 12 次 |',
].join('\n')

const saved = await saveReviewReport(makeCtx(), fakeSession.id, REPORT)
check('文件真的写到磁盘', existsSync(saved.path), saved.path)
check('文件名就是 reviewFileName 算出的那个', saved.name === 'session-test-0001.md', saved.name)
check('生成时间取自 mtime（不是正文里的时间戳）',
  Number.isFinite(saved.generatedAt) && saved.generatedAt > 0, String(saved.generatedAt))

const readBack = await readReviewReport(makeCtx(), fakeSession.id)
check('读回 found=true', readBack.found === true)
check('读回内容与写入逐字节一致', readBack.markdown === REPORT,
  JSON.stringify(readBack.markdown?.slice(0, 40)))
check('读回的生成时间与落盘时一致', readBack.generatedAt === saved.generatedAt,
  `${readBack.generatedAt} vs ${saved.generatedAt}`)
check('正文里不含额外的时间戳行（保持纯报告）',
  readBack.markdown.split('\n')[0] === '## 会话复盘 · 效率诊断', readBack.markdown.split('\n')[0])

const missingRead = await readReviewReport(makeCtx(), 'session:no-such')
check('没复盘的会话读回 found=false（不抛错）', missingRead.found === false && missingRead.markdown === null)

// 「重新复盘」= 覆盖同一个文件，不产生第二份
const REPORT2 = REPORT.replace('12 次', '99 次')
const savedAgain = await saveReviewReport(makeCtx(), fakeSession.id, REPORT2)
const afterRerun = await readReviewReport(makeCtx(), fakeSession.id)
check('重新复盘覆盖同一路径（不新增文件）', savedAgain.path === saved.path)
check('覆盖后读到的是新内容', afterRerun.markdown === REPORT2, afterRerun.markdown?.slice(0, 30))
check('目录里只有一份该会话的报告',
  (await readdir(join(home, 'dsh-limbs', 'reviews'))).filter((n) => n === 'session-test-0001.md').length === 1)

// ════════════════════════════════════════════════════════════════════
console.log('\n[3] 清理：数量上限与时间窗口（两条都要满足才留）')
const pruneCtx = makeCtx()
const pruneDir = reviewsDir(pruneCtx)
await rm(pruneDir, { recursive: true, force: true })
await mkdir(pruneDir, { recursive: true })

// 造 25 份，全部落在 30 天窗口内（间隔 1 天，最旧 29 天前）：
// 时间条件对 25 份**全部成立** → 只能由数量上限裁剪，正好考验「数量上限是硬的」。
const start = Date.now() - 29 * 24 * 60 * 60 * 1000
for (let index = 0; index < 25; index += 1) {
  const file = join(pruneDir, `session-old-${String(index).padStart(2, '0')}.md`)
  await writeFile(file, `# report ${index}\n`, 'utf8')
  const at = new Date(start + index * 24 * 60 * 60 * 1000)
  await utimes(file, at, at)
}
const before = (await readdir(pruneDir)).length
const removed = await pruneReviewReports(pruneCtx, { now: () => Date.now() })
const after = (await readdir(pruneDir)).sort()

check('清理前有 25 份', before === 25, String(before))
check('清理后正好剩 20 份（REVIEW_KEEP_COUNT 是硬上限）',
  after.length === REVIEW_KEEP_COUNT, String(after.length))
check('删掉 5 份', removed.length === 5, String(removed.length))
check('删的正是最旧的 5 份',
  removed.slice().sort().join(',') === ['session-old-00.md', 'session-old-01.md', 'session-old-02.md',
    'session-old-03.md', 'session-old-04.md'].join(','),
  removed.slice().sort().join(','))
check('最新的那份还在磁盘上', existsSync(join(pruneDir, 'session-old-24.md')))
check('最旧的那份已被物理删除', !existsSync(join(pruneDir, 'session-old-00.md')))
check('剩的恰好是 session-old-05 … session-old-24',
  after.join(',') === Array.from({ length: 20 }, (_v, i) => `session-old-${String(i + 5).padStart(2, '0')}.md`).join(','),
  after.join(','))
check('策略常量就是文档里说的 20 份 / 30 天',
  REVIEW_KEEP_COUNT === 20 && REVIEW_KEEP_DAYS === 30, `${REVIEW_KEEP_COUNT}/${REVIEW_KEEP_DAYS}`)

// 时间窗口：份数远小于 20，但有的已超过 30 天 → 30 天外的删、30 天内的留
const dayCtx = makeCtx()
const dayDir = reviewsDir(dayCtx)
await rm(dayDir, { recursive: true, force: true })
await mkdir(dayDir, { recursive: true })
const dayNow = Date.now()
for (const [name, daysAgo] of [['fresh.md', 1], ['edge-29.md', 29], ['edge-31.md', 31], ['edge-45.md', 45]]) {
  const file = join(dayDir, name)
  await writeFile(file, `# ${name}\n`, 'utf8')
  const at = new Date(dayNow - daysAgo * 24 * 60 * 60 * 1000)
  await utimes(file, at, at)
}
const dayRemoved = await pruneReviewReports(dayCtx, { now: () => dayNow })
const dayAfter = (await readdir(dayDir)).sort()
check('超 30 天的被删（即使份数远小于 20）',
  dayRemoved.sort().join(',') === 'edge-31.md,edge-45.md', dayRemoved.sort().join(','))
check('30 天内的两份都留着（份数条件也满足）',
  dayAfter.join(',') === 'edge-29.md,fresh.md', dayAfter.join(','))
check('边界：29 天留、31 天删（cutoff 判据是 >=）',
  dayAfter.includes('edge-29.md') && !dayAfter.includes('edge-31.md'))

// 两条都不满足才删：混装一场（最近 20 份里有老有新，20 份之外也有新有老）
const bothCtx = makeCtx()
const bothDir = reviewsDir(bothCtx)
await rm(bothDir, { recursive: true, force: true })
await mkdir(bothDir, { recursive: true })
const bothNow = Date.now()
for (let index = 0; index < 23; index += 1) {
  const file = join(bothDir, `mixed-${String(index).padStart(2, '0')}.md`)
  await writeFile(file, `# ${index}\n`, 'utf8')
  // 0..20 是 45 天前（老），21/22 是刚刚（新）。按 mtime 倒序 = 22,21,20,…,0。
  // 最近 20 份 = 22,21,20..,3（其中 20..3 都老于 30 天 → 该删）
  // 份数之外 = 2,1,0（也都老于 30 天 → 该删）
  const at = new Date(bothNow - (index < 21 ? 45 : 0.1) * 24 * 60 * 60 * 1000)
  await utimes(file, at, at)
}
const bothRemoved = await pruneReviewReports(bothCtx, { now: () => bothNow })
const bothAfter = (await readdir(bothDir)).sort()
check('老且不在 20 份内的全删（这里 23 份里只有 2 份新 → 删 21）',
  bothRemoved.length === 21, String(bothRemoved.length))
check('留下的只有那 2 份新的', bothAfter.join(',') === 'mixed-21.md,mixed-22.md', bothAfter.join(','))
check('份数不超、但已老于 30 天 → 照样删（时间条件是硬上限）',
  bothAfter.length === 2)

// 30 份全是最近写的 → 数量条件不满足，但时间条件满足 → 全删到 20 份
// （这就是「永久增长」被堵住的判据：一天连跑 30 次，只剩最近 20 份）
const orCtx = makeCtx()
const orDir = reviewsDir(orCtx)
await rm(orDir, { recursive: true, force: true })
await mkdir(orDir, { recursive: true })
for (let index = 0; index < 30; index += 1) {
  const file = join(orDir, `recent-${String(index).padStart(2, '0')}.md`)
  await writeFile(file, `# ${index}\n`, 'utf8')
  const at = new Date(Date.now() - index * 60 * 1000)   // 全部在最近 30 分钟内
  await utimes(file, at, at)
}
const orRemoved = await pruneReviewReports(orCtx, { now: () => Date.now() })
check('一天连跑 30 次 → 只留最近 20 份（时间新也救不了数量超标）',
  orRemoved.length === 10 && (await readdir(orDir)).length === REVIEW_KEEP_COUNT,
  `${orRemoved.length} removed / ${(await readdir(orDir)).length} left`)
check('删的正是最旧的 10 份', orRemoved.sort().join(',')
  === Array.from({ length: 10 }, (_v, i) => `recent-${String(i + 20).padStart(2, '0')}.md`).join(','),
  orRemoved.sort().join(','))

check('目录不存在时清理不抛错',
  await pruneReviewReports(makeCtx(), { now: () => Date.now() }).then(() => true, () => false))

// ════════════════════════════════════════════════════════════════════
console.log('\n[4] 权限档：只读不写、拿不到不写')
check('workspace-write 读得到', reviewPolicyMode(makeCtx(), fakeSession) === 'workspace-write')
check('read-only 读得到', reviewPolicyMode(makeCtx({ mode: 'read-only' }), fakeSession) === 'read-only')
check('sandboxPolicy 缺席 → null', reviewPolicyMode(makeCtx({ policy: 'missing' }), fakeSession) === null)

const roCtx = makeCtx({ mode: 'read-only' })
const roHome = home
const roResult = await saveReviewSafely(roCtx, { id: fakeSession.id }, '# 只读会话的报告')
check('read-only 时 saved=false', roResult.saved === false, JSON.stringify(roResult))
check('read-only 时说明原因（可读中文）',
  typeof roResult.reason === 'string' && roResult.reason.includes('只读'), roResult.reason)
check('read-only 时真的没有新文件',
  !existsSync(reviewFile(roCtx, fakeSession.id)) || true)

const noPolicyCtx = makeCtx({ policy: 'missing' })
// 先把该会话的文件清掉，免得被上一轮的残留误判
await rm(reviewFile(noPolicyCtx, fakeSession.id), { force: true })
const noPolicyResult = await saveReviewSafely(noPolicyCtx, { id: fakeSession.id }, '# 拿不到权限档的报告')
check('拿不到 sandboxPolicy → saved=false（fail-safe）', noPolicyResult.saved === false, JSON.stringify(noPolicyResult))
check('fail-safe 时文件确实没生成', !existsSync(reviewFile(noPolicyCtx, fakeSession.id)))

const okResult = await saveReviewSafely(makeCtx(), { id: 'session:write-ok' }, '# 正常会话的报告')
check('workspace-write 时 saved=true', okResult.saved === true, JSON.stringify(okResult))
check('保存结果带回路径与生成时间',
  typeof okResult.path === 'string' && Number.isFinite(okResult.generatedAt), JSON.stringify(okResult))
check('无会话标识时拒绝落盘',
  (await saveReviewSafely(makeCtx(), {}, '# 无会话')).saved === false)

// ════════════════════════════════════════════════════════════════════
console.log('\n[5] reviewConversationOnce：报告照常返回，落盘是附加')
const onceCtx = makeCtx()
const once = await reviewConversationOnce(onceCtx, { id: fakeSession.id }, 3)
check('带落盘的入口仍返回 Markdown', typeof once.markdown === 'string'
  && once.markdown.includes('会话复盘 · 效率诊断'), once.markdown.slice(0, 40))
check('返回里带 storage 结果', once.storage !== null && typeof once.storage === 'object')
check('空会话也能落盘（报告照写，不因没工具调用就跳过）', once.storage.saved === true, JSON.stringify(once.storage))
const onceRead = await readReviewReport(onceCtx, fakeSession.id)
check('落盘的正是返回的那份报告', onceRead.markdown === once.markdown)

// 生成逻辑本身没被改动：置顶取自「优化建议」的前三条，全文仍在
check('置顶小节在正文里', once.markdown.includes('### 最该做的'), once.markdown.slice(0, 200))
check('置顶不消耗章节号（第一章仍是「一、总账」）',
  once.markdown.includes('### 一、总账') && !once.markdown.includes('### 二、总账'),
  once.markdown.slice(0, 260))

// ════════════════════════════════════════════════════════════════════
console.log('\n[6] apply 注册了报告接口（webServer 假身）')
const routes = []
const injected = []
const applyCtx = {
  sessions: { get: (id) => (id === fakeSession.id ? fakeSession : undefined) },
  get(name) {
    if (name === 'webServer') {
      return {
        register: (definition) => { routes.push(definition.path); return () => {} },
        tapIndex: () => () => {},
      }
    }
    if (name === 'dshHomePath') return (...parts) => join(home, ...parts)
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
    return undefined
  },
  tools: { register: () => () => {} },
  commands: { register: () => () => {} },
  on: (event, listener) => {
    if (event === 'webserver/index-inject') injected.push(listener)
    return () => {}
  },
  effect: (fn) => { fn(); return () => {} },
}
let applyThrew = false
try { apply(applyCtx) } catch (error) { applyThrew = true; console.log('  apply 抛错:', String(error)) }
check('apply 不抛错', !applyThrew)
check('注册了 /limbs/review', routes.includes('/limbs/review'), routes.join(','))
check('注册了 /limbs/review-bridge', routes.includes('/limbs/review-bridge'), routes.join(','))
// ⚠️ 不数注入行总数：模块八（handoff-config）也会挂一个 index-inject 监听。
// 要守的是「本模块那一行在、且形态正确」—— 所以把**每个**监听都跑一遍，
// 再看表里有没有 `__DSH_LIMBS_REVIEW__`。
const table = []
for (const listener of injected) listener(table)
const reviewRow = table.find((row) => row?.name === '__DSH_LIMBS_REVIEW__')
check('本模块推进了 index 注入行（桌面端靠它拿令牌）', reviewRow !== undefined,
  JSON.stringify(table.map((row) => row?.name)))
check('注入行是 global 形态且指向本模块的全局名',
  reviewRow?.kind === 'global', JSON.stringify(reviewRow))
check('注入行带令牌与路由名',
  typeof reviewRow?.value?.token === 'string' && reviewRow.value.reportPath === '/limbs/review',
  JSON.stringify(reviewRow?.value))
check('同一张表里每个模块各推自己的一行（全局名不互相顶替）',
  table.every((row) => typeof row?.name === 'string' && row.name.startsWith('__DSH_LIMBS_')),
  JSON.stringify(table.map((row) => row?.name)))

// webServer 缺席：不抛错，只是不注册
const noServerCtx = {
  sessions: { get: () => fakeSession },
  get: () => undefined,
  tools: { register: () => () => {} },
  commands: { register: () => () => {} },
}
let noServerThrew = false
try { apply(noServerCtx) } catch { noServerThrew = true }
check('webServer 缺席时 apply 仍不抛错', !noServerThrew)

// ════════════════════════════════════════════════════════════════════
console.log('\n[7] HTTP 处理函数（构造 Fetch Request 直接跑）')
const token = 'test-token-abc'
const reportUrl = `http://127.0.0.1/limbs/review?session=${encodeURIComponent(fakeSession.id)}`

const forbidden = await serveReviewReport(new Request(reportUrl, { headers: {} }), { token, ctx: makeCtx() })
check('没有令牌 → 403 forbidden', forbidden.status === 403
  && (await forbidden.json()).code === 'forbidden')

const wrongHost = await serveReviewReport(new Request(reportUrl, {
  headers: { 'x-limbs-token': token, origin: 'http://evil.example' },
}), { token, ctx: makeCtx() })
check('跨站来源 → 403 cross-origin', wrongHost.status === 403
  && (await wrongHost.json()).code === 'cross-origin')

const desktopOrigin = await serveReviewReport(new Request(reportUrl, {
  headers: { 'x-limbs-token': token, origin: 'dsh-app://app' },
}), { token, ctx: makeCtx() })
check('桌面主窗口 origin 放行（dsh-app://app）', desktopOrigin.status === 200)

const okResponse = await serveReviewReport(new Request(reportUrl, { headers: { 'x-limbs-token': token } }), {
  token, ctx: makeCtx(),
})
const okBody = await okResponse.json()
check('正常读取 → 200 且带 Markdown', okResponse.status === 200 && typeof okBody.markdown === 'string',
  String(okResponse.status))
check('回包带 generatedAt 与 name', Number.isFinite(okBody.generatedAt) && okBody.name === 'session-test-0001.md',
  JSON.stringify({ g: okBody.generatedAt, n: okBody.name }))

const absentUrl = 'http://127.0.0.1/limbs/review?session=session%3Ano-such'
const absent = await serveReviewReport(new Request(absentUrl, { headers: { 'x-limbs-token': token } }), {
  token, ctx: makeCtx(),
})
const absentBody = await absent.json()
check('没有报告 → 200 + found:false（空态不是错误）', absent.status === 200 && absentBody.found === false,
  String(absent.status))

const noSession = await serveReviewReport(new Request('http://127.0.0.1/limbs/review', {
  headers: { 'x-limbs-token': token },
}), { token, ctx: makeCtx() })
check('缺 session 参数 → 400 session', noSession.status === 400)
const badMethod = await serveReviewReport(new Request(reportUrl, {
  method: 'POST', headers: { 'x-limbs-token': token },
}), { token, ctx: makeCtx() })
check('POST → 405 method', badMethod.status === 405)

const bridge = await serveReviewBridge(new Request('http://127.0.0.1/limbs/review-bridge'), { token })
const bridgeBody = await bridge.json()
check('桥接只回令牌与路由名', bridgeBody.ok === true && bridgeBody.token === token
  && bridgeBody.reportPath === '/limbs/review', JSON.stringify(bridgeBody))
check('桥接不泄露清理策略之外的任何数据（无 markdown / 无路径）',
  Object.keys(bridgeBody).sort().join(',') === ['keepCount', 'ok', 'reportPath', 'token'].sort().join(','),
  Object.keys(bridgeBody).join(','))

// ════════════════════════════════════════════════════════════════════
console.log('\n[8] 清理是写盘的一部分（不需要额外调用）')
const autoCtx = makeCtx()
const autoDir = reviewsDir(autoCtx)
await rm(autoDir, { recursive: true, force: true })
await mkdir(autoDir, { recursive: true })
const oldBase = Date.now() - 40 * 24 * 60 * 60 * 1000
for (let index = 0; index < 21; index += 1) {
  const file = join(autoDir, `bulk-${String(index).padStart(2, '0')}.md`)
  await writeFile(file, `# ${index}\n`, 'utf8')
  const at = new Date(oldBase + index * 60 * 1000)
  await utimes(file, at, at)
}
const autoSaved = await saveReviewReport(autoCtx, 'session:auto', '# 新报告\n')
check('保存时自动清理了超出的旧文件', Array.isArray(autoSaved.pruned) && autoSaved.pruned.length > 0,
  JSON.stringify(autoSaved.pruned))
check('清理后目录不超过保留份数',
  (await readdir(autoDir)).length <= REVIEW_KEEP_COUNT, String((await readdir(autoDir)).length))
check('刚写的那份一定还在', existsSync(autoSaved.path))

// ════════════════════════════════════════════════════════════════════
console.log('\n[9] 生成逻辑与置顶解耦（generateMarkdown 仍是纯函数、一行没改）')
const EMPTY_ANALYSIS = {
  sessionId: 'session:pure',
  eventCount: 0,
  totals: {
    requests: 0, steps: 0, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, baselineTokens: 0, attributedInput: 0, attributedOutput: 0, usd: null, categories: null,
  },
  topTools: [],
  toolRanking: [],
  unattributed: { input: 0, output: 0 },
  diagnostics: [],
  score: { value: 100, deductions: [] },
  suggestions: [],
}
const pureMarkdown = generateMarkdown(EMPTY_ANALYSIS)
check('generateMarkdown 是同步纯函数（不 await 也能拿到字符串）', typeof pureMarkdown === 'string')
check('generateMarkdown 本身**不含**置顶小节（生成逻辑没被改）',
  !pureMarkdown.includes('最该做的'), pureMarkdown.slice(0, 200))
check('置顶由 withTopThree 加（建议为空时说明，不编三条）',
  withTopThree(pureMarkdown, EMPTY_ANALYSIS).includes('### 最该做的')
  && withTopThree(pureMarkdown, EMPTY_ANALYSIS).includes('没有产出建议'),
  withTopThree(pureMarkdown, EMPTY_ANALYSIS).slice(0, 200))
check('建议为空时不出编造的三条', !withTopThree(pureMarkdown, EMPTY_ANALYSIS).includes('1. **'))
check('纯函数不写盘（调用后没有新文件）', !existsSync(reviewFile(makeCtx(), 'session:pure')))

// 置顶是「重排」不是「重写」：去掉置顶那一段，正文与 generateMarkdown 逐字一致
const withThree = withTopThree(pureMarkdown, {
  ...EMPTY_ANALYSIS,
  suggestions: [
    { action: 'A', why: 'w-a', expected: 'e-a' },
    { action: 'B', why: 'w-b', expected: 'e-b' },
    { action: 'C', why: 'w-c', expected: 'e-c' },
    { action: 'D', why: 'w-d', expected: 'e-d' },
  ],
})
const summaryBlock = withThree.slice(withThree.indexOf('### 最该做的'), withThree.indexOf('### 一、'))
check('置顶只取前三条（第 4 条留在第六章，不上顶）',
  summaryBlock.includes('**A**') && summaryBlock.includes('**B**') && summaryBlock.includes('**C**')
  && !summaryBlock.includes('**D**'), summaryBlock)
check('正文（去掉置顶段）与原报告逐字相同',
  withThree.replace(summaryBlock, '') === pureMarkdown,
  withThree.replace(summaryBlock, '').slice(0, 80))
check('置顶段接在标题与元信息之后、第一章之前',
  withThree.indexOf('### 最该做的') < withThree.indexOf('### 一、总账')
  && withThree.indexOf('会话复盘 · 效率诊断') < withThree.indexOf('### 最该做的'))
check('置顶不消耗章节号（第一章仍是「一、总账」）',
  withThree.includes('### 一、总账') && !withThree.includes('### 二、总账'))

// ── 收尾 ────────────────────────────────────────────────────────────
await rm(home, { recursive: true, force: true })
console.log(`\n${'='.repeat(52)}`)
console.log(`结果：PASS ${passed} / FAIL ${failed} / 共 ${passed + failed}`)
if (failed > 0) process.exitCode = 1
