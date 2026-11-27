/**
 * 模块三离线测试：不启动 DSH，用假会话事件验证
 *   fetchTraceData → analyzeData → generateMarkdown
 *
 * 跑法（本机没有 node 在 PATH 上，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\postmortem-test.mjs
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  fetchTraceData, analyzeData, generateMarkdown, reviewConversation, apply,
  LIMBS_CONFIG_ENTRY, LIMBS_CONFIG_SPEC, buildLimbsConfig,
} from '../lib/host.js'

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

function approx(actual, expected, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance
}

/** 构造一个假 Session，形状对齐真实 Session 的最小可读面。 */
function makeSession(events) {
  return {
    id: 'session:test-0001',
    header: { cwd: 'D:\\Projects\\dsh-limbs', createdAt: 1_700_000_000_000 },
    seq: events.length,
    ownEvents: () => events,
  }
}

/** 造事件：seq/time 自增，data 原样。 */
function eventBuilder() {
  const events = []
  let seq = 0
  const time = () => 1_700_000_000_000 + seq * 100
  const push = (type, data) => {
    seq += 1
    events.push({ type, seq, time: time(), data })
  }
  return { events, push }
}

function textContent(bytes) {
  return [{ type: 'text', text: 'x'.repeat(bytes) }]
}

// ── 场景 A：典型浪费会话 ────────────────────────────────────────────
function scenarioWasteful() {
  const { events, push } = eventBuilder()

  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('user/message', { role: 'user', content: [{ type: 'text', text: '帮我看看这个项目' }] })

  // 第 1 次模型请求：12k 输入（初始上下文）
  push('assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
    usage: { inputTokens: 12_000, outputTokens: 600 },
  })

  // 同一个 read 调用 3 次，同参数，每次 20KB 结果 → 命中 repeat-call + full-read
  for (let index = 0; index < 3; index += 1) {
    const callId = `call-read-${index}`
    push('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{"path":"src/big.js"}' })
    push('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: textContent(20_000) },
    })
  }
  push('step/end', { turn: 1, step: 1 })

  push('step/start', { turn: 1, step: 2 })
  // 第 2 次请求：26k 输入 → 相对上次增量 14k，归给上一步的 3 个 read
  push('assistant/message', {
    turn: 1, step: 2, message: { role: 'assistant', content: [] }, stream: [],
    usage: { inputTokens: 26_000, outputTokens: 400 },
  })
  push('tool/call', { turn: 1, step: 2, callId: 'call-pwsh-1', name: 'pwsh', arguments: '{"command":"ls -R"}' })
  push('tool/result', {
    turn: 1, step: 2,
    message: {
      role: 'tool', toolCallId: 'call-pwsh-1', source: { kind: 'tool', callId: 'call-pwsh-1' },
      content: textContent(9_000), isError: true,
    },
    error: { name: 'CommandFailed', code: 'EXIT_1' },
  })
  push('step/end', { turn: 1, step: 2 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return makeSession(events)
}

// ── 场景 B：干净会话（无工具）────────────────────────────────────────
function scenarioClean() {
  const { events, push } = eventBuilder()
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('user/message', { role: 'user', content: [{ type: 'text', text: '你好' }] })
  push('assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
    usage: { inputTokens: 3_000, outputTokens: 120 },
  })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return makeSession(events)
}

const fakeCtx = session => ({ sessions: { get: id => (id === session.id ? session : undefined) } })

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 A] 典型浪费会话')
const sessionA = scenarioWasteful()
const traceA = fetchTraceData(fakeCtx(sessionA), { id: sessionA.id })

check('事件被完整读取', traceA.eventCount === sessionA.ownEvents().length, `got ${traceA.eventCount}`)
check('识别 2 个 step', traceA.steps.length === 2, `got ${traceA.steps.length}`)
check('识别 4 次工具调用', traceA.calls.length === 4, `got ${traceA.calls.length}`)
check('两次 assistant/message 都带 usage', traceA.usageSeries.length === 2, `got ${traceA.usageSeries.length}`)

const analysisA = analyzeData(traceA, { topN: 3 })

check('请求数 = 2', analysisA.totals.requests === 2, `got ${analysisA.totals.requests}`)
check('工具数 = 4', analysisA.totals.calls === 4, `got ${analysisA.totals.calls}`)
check('报错数 = 1', analysisA.totals.errors === 1, `got ${analysisA.totals.errors}`)
check('起始上下文 = 12000（第一次请求全额，不归工具）',
  analysisA.totals.baselineTokens === 12_000, `got ${analysisA.totals.baselineTokens}`)

// 差分核心：第二次 input 26000 − 第一次 12000 = 14000，全部归给上一步的 3 个 read
const attributedInputTotal = traceA.calls.reduce((sum, call) => sum + call.attributedInput, 0)
check('差分归因总量 = 14000', approx(attributedInputTotal, 14_000, 3), `got ${attributedInputTotal}`)

const readCalls = traceA.calls.filter(call => call.name === 'read')
check('3 个 read 均分了 14000 增量',
  readCalls.every(call => approx(call.attributedInput, 14_000 / 3, 2)),
  readCalls.map(call => call.attributedInput).join(','))

const pwshCall = traceA.calls.find(call => call.name === 'pwsh')
check('本次工具不吞上一步的增量（pwsh 只拿自己那步的 output）',
  pwshCall.attributedInput === 0 && approx(pwshCall.attributedOutput, 400, 0),
  `in=${pwshCall.attributedInput} out=${pwshCall.attributedOutput}`)

check('read 的 outputTokens 总和 = 600',
  approx(readCalls.reduce((sum, call) => sum + call.attributedOutput, 0), 600, 1))

const ids = new Set(analysisA.diagnostics.map(item => item.id))
check('命中 repeat-call（3 次同参）', ids.has('repeat-call'))
check('命中 full-read（20KB 无 range）', ids.has('full-read'))
check('命中 terminal-heavy（9KB 终端）', ids.has('terminal-heavy'))
check('命中 tool-error（isError）', ids.has('tool-error'))
check('未误报 huge-result（20KB < 30KB 阈值）', !ids.has('huge-result'))

check('Top1 是 read', analysisA.topTools[0]?.name === 'read', analysisA.topTools[0]?.name)
check('评分落在 40–70 之间', analysisA.score.value >= 40 && analysisA.score.value <= 70, `got ${analysisA.score.value}`)
check('扣分项非空', analysisA.score.deductions.length > 0)
check('建议里含模块二调档（评分低时）',
  analysisA.suggestions.some(item => item.action.includes('模块二')))

const markdownA = generateMarkdown(analysisA)
check('Markdown 含总账标题', markdownA.includes('### 一、总账'))
check('Markdown 含归因标题', markdownA.includes('### 二、费用大头'))
check('Markdown 含诊断标题', markdownA.includes('### 三、效率诊断'))
check('Markdown 含评分标题', markdownA.includes('### 四、效率评分'))
check('Markdown 含建议标题', markdownA.includes('### 五、优化建议'))
check('Markdown 写出 read 工具名', markdownA.includes('`read`'))
check('Markdown 说明了差分口径', markdownA.includes('差分归因'))
check('同一批调用被多条诊断命中时标注去重', markdownA.includes('不重复计入'))

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 B] 干净会话')
const sessionB = scenarioClean()
const traceB = fetchTraceData(fakeCtx(sessionB), { id: sessionB.id })
const analysisB = analyzeData(traceB, { topN: 3 })

check('无工具调用', analysisB.totals.calls === 0)
check('无诊断项', analysisB.diagnostics.length === 0, `got ${analysisB.diagnostics.length}`)
check('评分 100', analysisB.score.value === 100, `got ${analysisB.score.value}`)
check('建议为「保持现状」', analysisB.suggestions[0]?.action === '保持现状')
check('报告不崩', generateMarkdown(analysisB).includes('没有产生可归因'))

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 C] 空会话 / 异常输入')
const sessionC = makeSession([])
const traceC = fetchTraceData(fakeCtx(sessionC), { id: sessionC.id })
check('空会话 eventCount = 0', traceC.eventCount === 0)
const analysisC = analyzeData(traceC)
check('空会话不崩且评分 100', analysisC.score.value === 100)
check('空会话可渲染', typeof generateMarkdown(analysisC) === 'string')

let threw = false
try {
  fetchTraceData({ sessions: { get: () => undefined } }, { id: 'nope' })
} catch { threw = true }
check('会话不存在时明确抛错', threw)

threw = false
try {
  fetchTraceData({ sessions: { get: () => sessionC } }, undefined)
} catch { threw = true }
check('缺少 agent 时明确抛错', threw)

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 D] dsh-context 投影可用')
const sessionD = scenarioWasteful()
const timelineD = {
  current: {
    system: 3_000, tools: 5_000, user: 1_000, inject: 200,
    skill: 0, assistant: 2_000, tool: 9_000, total: 20_200,
  },
  costRead: { usd: 0.0123, ready: true },
  timing: { tools: { read: { calls: 3, ms: 2_500 }, pwsh: { calls: 1, ms: 300 } } },
  toolTally: { read: 3, pwsh: 1 },
  commands: [{ tool: 'pwsh', outChars: 9_000, err: true }],
  fileOps: [],
  requests: [{ seq: 1 }, { seq: 2 }],
}
const projectionCtx = timeline => ({
  sessions: { get: id => (id === sessionD.id ? sessionD : undefined) },
  get: name => (name === 'sessionProjections'
    ? { snapshot: () => ({ asOfSeq: 99, values: { contextTimeline: timeline } }) }
    : undefined),
})

const traceD = fetchTraceData(projectionCtx(timelineD), { id: sessionD.id })
check('投影被读取', traceD.projection !== null)
check('投影带出美元金额', traceD.projection?.usd === 0.0123, String(traceD.projection?.usd))
check('投影带出类别构成', traceD.projection?.categories?.total === 20_200)

const analysisD = analyzeData(traceD, { topN: 3 })
check('总账接入金额', analysisD.totals.usd === 0.0123)
check('总账接入类别', analysisD.totals.categories?.tool === 9_000)
const readBucketD = analysisD.toolRanking.find(item => item.name === 'read')
check('工具耗时改用投影口径（2500ms）', readBucketD?.durationMs === 2_500, String(readBucketD?.durationMs))

const markdownD = generateMarkdown(analysisD)
check('报告出现金额行', markdownD.includes('$0.0123'))
check('报告出现上下文构成小节', markdownD.includes('、上下文构成'))
check('构成里有工具结果行', markdownD.includes('| 工具结果 |'))
check('有投影时诊断章节顺延为「四」', markdownD.includes('### 四、效率诊断'))
check('尾注说明投影来源', markdownD.includes('contextTimeline'))

// ── 降级：投影缺失 / 抛错都必须安静退回事件流 ──
const noProjectionCtx = {
  sessions: { get: id => (id === sessionD.id ? sessionD : undefined) },
  get: () => undefined,
}
const traceDegraded = fetchTraceData(noProjectionCtx, { id: sessionD.id })
check('投影缺失时降级且不炸', traceDegraded.projection === null && traceDegraded.calls.length === 4)

const throwingCtx = {
  sessions: { get: id => (id === sessionD.id ? sessionD : undefined) },
  get: () => ({ snapshot: () => { throw new Error('stateVersion mismatch') } }),
}
let degradeThrew = false
let traceThrew = null
try { traceThrew = fetchTraceData(throwingCtx, { id: sessionD.id }) } catch { degradeThrew = true }
check('投影抛错时捕获并降级', !degradeThrew && traceThrew.projection === null)

const markdownDegraded = generateMarkdown(analyzeData(traceDegraded, { topN: 3 }))
check('降级报告不出现金额行', !markdownDegraded.includes('| 费用 |'))
check('降级报告章节号回到「三、效率诊断」', markdownDegraded.includes('### 三、效率诊断'))

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 E] 两个入口的注册与命令 handler')
const sessionE = scenarioWasteful()
const registered = { tools: [], commands: [] }
const applyCtx = {
  sessions: { get: id => (id === sessionE.id ? sessionE : undefined) },
  get: () => undefined,
  tools: { register: definition => { registered.tools.push(definition); return () => {} } },
  commands: { register: definition => { registered.commands.push(definition); return () => {} } },
}
let applyThrew = false
try { apply(applyCtx) } catch { applyThrew = true }
check('apply 不抛错', !applyThrew)
// ⚠️ 不数总数：模块七（窗口交接）也往 ctx.tools 里注册工具，
// 数总数会让「模块三注册了自己的工具」这条断言被别的模块牵连。
// 真正要守的是「模块三那个工具在」，所以按名字判定。
const reviewTool = registered.tools.find(definition => definition.name === 'analyze_conversation_efficiency')
check('模块三注册了自己的分析工具', reviewTool !== undefined,
  `got ${JSON.stringify(registered.tools.map(definition => definition.name))}`)
check('工具名正确', registered.tools[0]?.name === 'analyze_conversation_efficiency', registered.tools[0]?.name)
check('工具带 output.render', typeof reviewTool?.output?.render === 'function')
check('工具 output.schema 是 string', reviewTool?.output?.schema?.type === 'string')
// ⚠️ 同样不数总数：模块七也注册命令（`/limbs-handoff-token`）。
const reviewCommand = registered.commands.find(definition => definition.name === 'limbs-review')
check('模块三注册了自己的复盘命令', reviewCommand !== undefined,
  `got ${JSON.stringify(registered.commands.map(definition => definition.name))}`)
check('命令名正确（无斜杠）', registered.commands[0]?.name === 'limbs-review', registered.commands[0]?.name)
check('命令带 description', typeof reviewCommand?.description === 'string')
check('命令带 input.hint', typeof reviewCommand?.input?.hint === 'string')

const commandResult = await registered.commands[0].handler({
  agent: { id: sessionE.id }, rawInput: '', attachments: [], signal: undefined, commandId: 'cmd:1',
})
check('命令 handler 返回 success', commandResult?.kind === 'success', commandResult?.kind)
check('命令文本含报告标题', String(commandResult?.text).includes('会话复盘 · 效率诊断'))

const limited = await registered.commands[0].handler({
  agent: { id: sessionE.id }, rawInput: '1', attachments: [], signal: undefined, commandId: 'cmd:2',
})
check('命令接受 top_n 参数', String(limited?.text).includes('费用大头'))

// 会话不存在时，命令必须给人类一句能读懂的话，而不是抛异常
let commandThrew = false
let failedResult = null
try {
  failedResult = await registered.commands[0].handler({
    agent: { id: 'session:missing' }, rawInput: '', attachments: [], signal: undefined, commandId: 'cmd:3',
  })
} catch { commandThrew = true }
check('会话缺失时命令不抛异常', !commandThrew)
check('会话缺失时命令返回 error 结果', failedResult?.kind === 'error', failedResult?.kind)
check('错误文本说明了原因', String(failedResult?.text).includes('不在内存 Session 注册表'), String(failedResult?.text))

// 工具与命令走同一条实现
const viaHelper = reviewConversation(applyCtx, { id: sessionE.id }, 3)
check('reviewConversation 直接可用', viaHelper.includes('会话复盘 · 效率诊断'))

// ════════════════════════════════════════════════════════════════════
console.log('\n[场景 F] 模块三的 Host Config schema（真 Schemastery）')
// 生产路径 `Config` 依赖 `@deepseek-ai/schemastery`（peerDependency，宿主提供）。
// 本仓库自己没装这个包，所以这里用 **DSH profile 里那一份真库**验证同一份规格：
// schema 形状、默认值、枚举、volatile 标记、非原生 schema 的拒绝行为。
function schemaLibUrl() {
  const home = process.env.DSH_HOME || 'D:/Apps/DSHData'
  return pathToFileURL(home + '/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs').href
}

let schemaLib = null
try {
  const module = await import(schemaLibUrl())
  schemaLib = module.default ?? module
} catch { schemaLib = null }

check('schemastery 从 DSH profile 解析得到', typeof schemaLib === 'function',
  String(schemaLibUrl()))

check('schema 规格：条目 id 就是 profile 里的 dsh-limbs', LIMBS_CONFIG_SPEC.entryId === LIMBS_CONFIG_ENTRY
  && LIMBS_CONFIG_ENTRY === 'dsh-limbs', LIMBS_CONFIG_SPEC.entryId)
check('schema 规格：两个字段（推理 / 费用超限）',
  JSON.stringify(LIMBS_CONFIG_SPEC.fields) === JSON.stringify(['effort', 'costWarn']),
  JSON.stringify(LIMBS_CONFIG_SPEC.fields))
check('schema 规格：推理枚举含关 / 默认 / 低 / 中 / 高 / 最高',
  JSON.stringify(LIMBS_CONFIG_SPEC.effort) === JSON.stringify(['off', 'provider-default', 'low', 'medium', 'high', 'max']),
  JSON.stringify(LIMBS_CONFIG_SPEC.effort))
check('schema 规格：默认值取自 DEFAULT_SETTINGS',
  LIMBS_CONFIG_SPEC.defaults.effort === 'provider-default'
  && LIMBS_CONFIG_SPEC.defaults.costWarn === true,
  JSON.stringify(LIMBS_CONFIG_SPEC.defaults))

if (schemaLib !== null) {
  const built = buildLimbsConfig(schemaLib)
  check('buildLimbsConfig 产出原生 Schemastery graph',
    built?.[Symbol.for('schemastery')] === true && typeof built.type === 'string'
    && built.meta !== null && typeof built.meta === 'object',
    String(built?.[Symbol.for('schemastery')]))
  check('原生 graph 正是 DSH 认的那种（isNativeConfigSchema 三条判据）',
    built?.[Symbol.for('schemastery')] === true && typeof built.type === 'string'
    && typeof built.meta === 'object')
  check('schema 根是 object 且字段齐全',
    built.type === 'object' && JSON.stringify(Object.keys(built.dict))
    === JSON.stringify(['effort', 'costWarn']),
    JSON.stringify(Object.keys(built.dict || {})))
  check('两个字段都标了 volatile（官方 configForms 只暴露这类字段）',
    built.dict.effort.meta.volatile === true && built.dict.costWarn.meta.volatile === true)
  check('字段默认值落在 schema 上，不用 apply 里再兜一遍',
    built.dict.effort.meta.default === 'provider-default'
    && built.dict.costWarn.meta.default === true,
    JSON.stringify([built.dict.effort.meta.default, built.dict.costWarn.meta.default]))
  // ⚠️ volatile 字段解析出来是「引用」对象（`{ get() }`），官方 `plainConfig`
  // 就是 `.get()` 一层把它摊平的；断言照同一条口径走，别直接比值。
  const plain = (value, key) => {
    const raw = value === null || value === undefined ? undefined : value[key]
    return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  }
  const resolved = built({})
  check('空配置解析成默认值',
    plain(resolved, 'effort') === 'provider-default'
    && plain(resolved, 'costWarn') === true,
    JSON.stringify(['effort', 'costWarn'].map(key => plain(resolved, key)))
    + ' · ' + JSON.stringify(resolved))
  let rejectedEffort = null
  try { built({ effort: 'turbo' }) } catch (error) { rejectedEffort = error.message }
  check('不认识的推理档位被拒绝', rejectedEffort !== null, String(rejectedEffort))
  const accepted = built({ effort: 'high', costWarn: false })
  check('合法枚举通过校验',
    plain(accepted, 'effort') === 'high'
    && plain(accepted, 'costWarn') === false,
    JSON.stringify(['effort', 'costWarn'].map(key => plain(accepted, key))) + ' · ' + JSON.stringify(accepted))
  const roundtrip = built.toJSON()
  check('schema 可序列化（官方序列化用的就是 toJSON）', roundtrip !== null && typeof roundtrip === 'object')
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(52)}`)
console.log(`结果：PASS ${passed} / FAIL ${failed} / 共 ${passed + failed}`)
if (failed > 0) process.exitCode = 1

// 打印一份真实渲染结果，肉眼过一遍排版
// ⚠️ 这里打的是 `reviewConversation` 的产物（含置顶摘要），不是裸的
//    `generateMarkdown` —— 用户实际看到的是前者，肉眼该过的也是它。
if (process.argv.includes('--print')) {
  console.log('\n' + '─'.repeat(52) + '\n')
  console.log(reviewConversation(applyCtx, { id: sessionA.id }))
}
