/**
 * Host half of dsh-limbs — 模块三：事后复盘分析器（Post-mortem Analyzer）。
 *
 * 纯分析型：只读当前 Session 的已提交事件日志，产出「省钱 / 提速」诊断。
 * 不写日志、不联网、不注册服务、不改会话状态。
 *
 * ── 数据来源（已按 DSH 0.2.2-rc.3 实测核对，非推测）────────────────────
 *
 *   ctx.sessions.get(agent.id)  →  Session
 *   Session.ownEvents()         →  本会话自己的事件（不含 fork 继承）
 *
 * 三个事件是全部所需，**没有独立的 usage 事件**：
 *
 *   'tool/call'         { turn, step, callId, name, arguments }   ← arguments 是原始 JSON 字符串
 *   'tool/result'       { turn, step, message, error?, meta? }    ← message.content 是 ContentBlock[]
 *   'assistant/message' { turn, step, message, usage?, ... }      ← usage: TokenUsage 唯一来源
 *
 * TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
 *
 * ── 费用归因口径（关键，别算歪）──────────────────────────────────────
 *
 * inputTokens 是「整段前缀」的总量，不是增量。直接把某步的 inputTokens 记到
 * 该步的工具头上会重复累加、虚高到没法看。本实现用差分：
 *
 *   第 N 步的 inputTokens − 第 N−1 步的 inputTokens ≈ 第 N 步新增的上下文
 *
 * 而这段新增上下文正是「第 N−1 步的工具结果」撑起来的，所以差分归给
 * 第 N−1 步的工具，按各工具结果字节数比例分摊。
 * outputTokens 属于本步生成，直接归本步的工具。
 *
 * 缓存命中（cacheReadTokens）按 0 价重复计费会失真，本报告只做展示、不参与
 * 归因排名，避免给出一个编造的折扣价。
 *
 * ── 关于依赖 ──────────────────────────────────────────────────────
 *
 * 刻意不 import @deepseek-ai/*：第三方插件在 profile 目录下能否解析到
 * dsh 安装内的包未经实测，而 ctx.tools.register() 接受纯 ToolDefinition
 * 对象（ToolSchema 的 parameters 就是 JSON Schema）。零依赖最稳。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CONTEXT_LEVELS,
  DEFAULT_SETTINGS,
  MODEL_SETTINGS_VERSION,
  REASONING_LEVELS,
  buildLevels,
  mapLegacyContext,
  mapLegacyReasoning,
  migrateSettings,
} from './model-management/levels.js'
import { applyHandoffTools, createHandoffAssembler } from './handoff.js'
import { createHandoffConfigBridge } from './handoff-config.js'

/** 三个服务都必须存在，否则 apply 不执行。 */
export const inject = ['tools', 'commands', 'sessions']

// ─────────────────────────────────────────────────────────────────────
// 模块三 · 「Limbs 配置」的 Host Config schema
// ─────────────────────────────────────────────────────────────────────
//
// 三个字段是**真契约**，不再是占位：
//
//   context   上下文长度（枚举取自 `model-management/levels.js`）
//   effort    推理强度（同上）
//   costWarn  费用超限时提示（布尔）
//
// 为什么全是 `.volatile()`：Client 侧走官方 `ctx.configForms.get('dsh-limbs')`
// 读写，而那个服务**只暴露 volatile 字段**；标了 volatile 的字段改完就地生效，
// 不重启插件（普通字段会重启整个插件）。
//
// 为什么 schema 要真身：DSH 只认「原生 Schemastery 对象」（`isNativeConfigSchema`
// 看 `Symbol.for('schemastery')` + `type` + `meta`），手写的假对象会被判
// `unsupported` 并留诊断 —— 写假的就是"假装能用"。本包刻意零运行时依赖，
// 所以 `@deepseek-ai/schemastery` 走 **peerDependencies**（宿主提供，profile
// 里本来就装着）；解析不到时不抛错、只是不声明 `Config`，字段真源由
// `LIMBS_CONFIG_SPEC` 承担，离线测试拿真库直接验证这份规格。

/** 本插件在 profile 里的条目 id（= 设置命名空间 = `cordis.patch.yml` 的 `id`）。 */
export const LIMBS_CONFIG_ENTRY = 'dsh-limbs'

/** 三个设置项的字段真源：默认值与真实枚举 id（标签在 `levels.js`，不复制）。 */
export const LIMBS_CONFIG_SPEC = Object.freeze({
  entryId: LIMBS_CONFIG_ENTRY,
  defaults: Object.freeze({
    context: DEFAULT_SETTINGS.context,
    effort: DEFAULT_SETTINGS.reasoning,
    costWarn: true,
  }),
  context: Object.freeze(CONTEXT_LEVELS.map(({ id }) => id)),
  effort: Object.freeze(REASONING_LEVELS.map(({ id }) => id)),
  fields: Object.freeze(['context', 'effort', 'costWarn']),
})

/**
 * 用真的 Schemastery 库拼出 Config。导出成函数是为了让离线测试能用 profile
 * 里的真库验证同一份规格（生产路径见下面的 `Config`）。
 *
 * @param {Function} schema `@deepseek-ai/schemastery` 的默认导出
 * @returns {object} 原生 Schemastery schema
 */
export function buildLimbsConfig(schema) {
  const enumOf = (ids, fallback, description) => schema
    .union(ids.map(id => schema.const(id)))
    .default(fallback)
    .description(description)
    .volatile()
  return schema.object({
    context: enumOf(LIMBS_CONFIG_SPEC.context, LIMBS_CONFIG_SPEC.defaults.context, '新会话默认上下文长度'),
    effort: enumOf(LIMBS_CONFIG_SPEC.effort, LIMBS_CONFIG_SPEC.defaults.effort, '新会话默认推理强度'),
    costWarn: schema.boolean()
      .default(LIMBS_CONFIG_SPEC.defaults.costWarn)
      .description('估算花费超过预算时在对话里提醒')
      .volatile(),
  })
}

/** 解析 Schemastery；离线测试环境解析不到就返回 null（不抛错）。 */
async function loadSchemaLib() {
  try {
    const module = await import('@deepseek-ai/schemastery')
    const schema = module.default ?? module
    return typeof schema === 'function' ? schema : null
  } catch {
    return null
  }
}

const SCHEMA_LIB = await loadSchemaLib()

/** 模块三的 Host Config；宿主没给 Schemastery 时不声明（退化为无 schema 条目）。 */
export const Config = SCHEMA_LIB === null ? undefined : buildLimbsConfig(SCHEMA_LIB)

// ─────────────────────────────────────────────────────────────────────
// 模块二 · 档位配置的服务端保存接口
// ─────────────────────────────────────────────────────────────────────
//
// 为什么不是 Config / settings 命名空间：
//   DSH 的 settings 命名空间来自插件的 Config schema，而本插件刻意零依赖
//   （第三方插件目录解析不到 @deepseek-ai/schemastery）。这里用 Web 服务
//   的公开注册面开一条窄接口，只做「按账号保存两个档位字段」这一件事：
//
//   GET  /limbs/model-settings   读取当前账号的设置
//   PUT  /limbs/model-settings   按 updatedAt 最新优先写入
//
// 数据落在 <DSH_HOME>/dsh-limbs/model-settings.json，按账号分桶，写盘用
// 临时文件 + rename。令牌由 Host 启动时随机生成，通过 index 注入到页面
// 全局；请求必须带 x-limbs-token，跨站来源一律拒绝。

export const MODEL_SETTINGS_ROUTE = '/limbs/model-settings'
const MODEL_SETTINGS_TOKEN_HEADER = 'x-limbs-token'
const MODEL_SETTINGS_MAX_BODY = 64 * 1024
const MODEL_SETTINGS_BRIDGE_GLOBAL = '__DSH_LIMBS_BRIDGE__'

/** 默认数据目录：优先 DSH_HOME，其次系统临时目录。 */
export function modelSettingsHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(tmpdir(), 'dsh-home')
}

/** 默认数据文件路径。 */
export function modelSettingsFile(home = modelSettingsHome()) {
  return join(home, 'dsh-limbs', 'model-settings.json')
}

function emptyModelSettingsDocument() {
  return { version: MODEL_SETTINGS_VERSION, revision: 0, accounts: {} }
}

function isKnownReasoning(id) {
  return REASONING_LEVELS.some((level) => level.id === id)
}

function isKnownContext(id) {
  return CONTEXT_LEVELS.some((level) => level.id === id)
}

/** 把磁盘内容收敛成可信结构；坏字段逐条回退，不让整份文件失效。 */
export function sanitizeModelSettingsDocument(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const accounts = {}
  const sourceAccounts = source.accounts !== null && typeof source.accounts === 'object' ? source.accounts : {}
  for (const [accountId, value] of Object.entries(sourceAccounts)) {
    if (typeof accountId !== 'string' || accountId === '') continue
    const migrated = migrateSettings(value)
    accounts[accountId] = {
      reasoning: isKnownReasoning(migrated.settings.reasoning) ? migrated.settings.reasoning : DEFAULT_SETTINGS.reasoning,
      context: isKnownContext(migrated.settings.context) ? migrated.settings.context : DEFAULT_SETTINGS.context,
      updatedAt: Number.isFinite(Number(value && value.updatedAt)) ? Math.max(0, Number(value.updatedAt)) : 0,
    }
  }
  return {
    version: MODEL_SETTINGS_VERSION,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(0, Math.floor(Number(source.revision))) : 0,
    accounts,
  }
}

/** 读设置文件；不存在、损坏都返回空文档。 */
export async function readModelSettingsDocument(file) {
  try {
    const text = await readFile(file, 'utf8')
    return sanitizeModelSettingsDocument(JSON.parse(text))
  } catch {
    return emptyModelSettingsDocument()
  }
}

/** 原子写：先写同目录临时文件，再 rename 覆盖。 */
export async function writeModelSettingsDocument(file, document) {
  const safe = sanitizeModelSettingsDocument(document)
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  await writeFile(temporary, JSON.stringify(safe, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
  return safe
}

/** 同一文件串行写盘，避免并发 PUT 互相覆盖。 */
const MODEL_SETTINGS_QUEUES = new Map()
function modelSettingsQueue(file) {
  if (!MODEL_SETTINGS_QUEUES.has(file)) {
    let tail = Promise.resolve()
    MODEL_SETTINGS_QUEUES.set(file, (operation) => {
      const run = tail.then(operation, operation)
      tail = run.then(() => undefined, () => undefined)
      return run
    })
  }
  return MODEL_SETTINGS_QUEUES.get(file)
}

/** 浏览器来源校验：同源或没有 Origin（非浏览器客户端）才放行。 */
function isSameOrigin(request) {
  const origin = request.headers.get('origin')
  if (origin === null || origin === 'null') return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function defaultAccountSettings() {
  return { ...DEFAULT_SETTINGS, updatedAt: 0 }
}

/**
 * 处理一次保存接口请求。导出纯函数，离线测试直接构造 Fetch Request。
 *
 * @param {Request} request
 * @param {object} options
 * @param {string} options.token - 必须匹配的访问令牌。
 * @param {string} options.file - 数据文件路径。
 * @param {() => number} [options.now] - 时间源，测试可注入。
 * @param {string|(() => string|Promise<string>)} [options.accountId] - 账号标识，测试可注入。
 * @returns {Promise<Response>}
 */
export async function serveModelSettings(request, options) {
  const token = options.token
  if (typeof token !== 'string' || token === ''
    || request.headers.get(MODEL_SETTINGS_TOKEN_HEADER) !== token) {
    return jsonResponse(403, { ok: false, code: 'forbidden', message: '没有权限写入档位设置。' })
  }
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { ok: false, code: 'cross-origin', message: '跨站请求已拒绝。' })
  }

  const now = typeof options.now === 'function' ? options.now : Date.now
  const accountId = typeof options.accountId === 'function' ? await options.accountId() : options.accountId
  const accountKey = typeof accountId === 'string' && accountId !== '' ? accountId : 'local'
  const levels = buildLevels({ showMax: true })

  if (request.method === 'GET') {
    const document = await readModelSettingsDocument(options.file)
    const settings = document.accounts[accountKey] || defaultAccountSettings()
    return jsonResponse(200, {
      ok: true,
      account: accountKey === 'local' ? 'local' : 'current',
      settings,
      revision: document.revision,
      levels,
      defaults: DEFAULT_SETTINGS,
    })
  }

  if (request.method !== 'PUT') {
    return jsonResponse(405, { ok: false, code: 'method', message: '只支持读取与保存。' }, { allow: 'GET, PUT' })
  }

  let text
  try {
    text = await request.text()
  } catch {
    return jsonResponse(400, { ok: false, code: 'body', message: '请求内容读取失败。' })
  }
  if (text.length > MODEL_SETTINGS_MAX_BODY) {
    return jsonResponse(413, { ok: false, code: 'body', message: '请求内容过大。' })
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return jsonResponse(400, { ok: false, code: 'json', message: '请求内容不是合法 JSON。' })
  }

  const input = body !== null && typeof body === 'object' ? body.settings : undefined
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return jsonResponse(400, { ok: false, code: 'settings', message: '缺少档位设置内容。' })
  }
  const rawReasoning = input.reasoning ?? input.effort ?? input.reasoningEffort ?? input.reasoningLevel
  const rawContext = input.context ?? input.contextLength ?? input.contextWindow ?? input.contextSize
  if ((rawReasoning !== undefined && rawReasoning !== null && mapLegacyReasoning(rawReasoning) === null)
    || (rawContext !== undefined && rawContext !== null && mapLegacyContext(rawContext) === null)) {
    return jsonResponse(400, { ok: false, code: 'settings', message: '档位取值不在允许范围内。' })
  }
  const migrated = migrateSettings(input)
  if (!isKnownReasoning(migrated.settings.reasoning) || !isKnownContext(migrated.settings.context)) {
    return jsonResponse(400, { ok: false, code: 'settings', message: '档位取值不在允许范围内。' })
  }

  const clientUpdatedAt = Number.isFinite(Number(input.updatedAt))
    ? Math.max(0, Number(input.updatedAt))
    : 0
  const write = modelSettingsQueue(options.file)
  const result = await write(async () => {
    const document = await readModelSettingsDocument(options.file)
    const stored = document.accounts[accountKey]
    if (stored !== undefined && stored.updatedAt > clientUpdatedAt) {
      return { conflict: true, document, settings: stored }
    }
    const updatedAt = Math.max(clientUpdatedAt, Number(now()) || Date.now())
    const settings = {
      reasoning: migrated.settings.reasoning,
      context: migrated.settings.context,
      updatedAt,
    }
    document.accounts[accountKey] = settings
    document.revision = (Number(document.revision) || 0) + 1
    const saved = await writeModelSettingsDocument(options.file, document)
    return { conflict: false, document: saved, settings }
  })

  if (result.conflict) {
    return jsonResponse(409, {
      ok: false,
      code: 'conflict',
      message: '设置已在其他设备更新。',
      settings: result.settings,
      revision: result.document.revision,
      levels,
      defaults: DEFAULT_SETTINGS,
    })
  }

  return jsonResponse(200, {
    ok: true,
    account: accountKey === 'local' ? 'local' : 'current',
    settings: result.settings,
    revision: result.document.revision,
    levels,
    defaults: DEFAULT_SETTINGS,
  })
}

/** 读取 Host 侧登录账号；读不到时用 local 桶，不阻塞保存。 */
async function resolveHostAccountId(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  if (account === undefined || account === null || typeof account.getDeviceIdentity !== 'function') return 'local'
  try {
    const identity = await account.getDeviceIdentity()
    return identity !== null && typeof identity === 'object' && typeof identity.userId === 'string' && identity.userId !== ''
      ? identity.userId
      : 'local'
  } catch {
    return 'local'
  }
}

function readRequestBody(request, limit = MODEL_SETTINGS_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求内容过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

/** 把 Node 的 req/res 适配成 Fetch Request/Response，复用同一套处理函数。 */
async function nodeHandler(req, res, handle) {
  try {
    const host = req.headers.host || '127.0.0.1'
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (typeof value === 'string') headers.set(name, value)
    }
    const method = req.method || 'GET'
    const body = method === 'PUT' ? await readRequestBody(req) : undefined
    const request = new Request(`http://${host}${req.url || MODEL_SETTINGS_ROUTE}`, { method, headers, body })
    const response = await handle(request)
    const outHeaders = {}
    response.headers.forEach((value, name) => { outHeaders[name] = value })
    const text = await response.text()
    res.writeHead(response.status, outHeaders)
    res.end(text)
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    }
    res.end(JSON.stringify({ ok: false, code: 'internal', message: '服务端保存失败：' + (error instanceof Error ? error.message : String(error)) }))
  }
}

/**
 * 挂载模块二的 Host 保存接口。
 *
 * webServer 缺席时静默降级（Client 会退回本机保存），不影响模块一/三。
 *
 * @param {object} ctx
 * @param {object} [options]
 * @returns {{route:string, file:string, dispose:() => void}|undefined}
 */
export function createModelSettingsBridge(ctx, options = {}) {
  const webServer = options.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return undefined

  const token = typeof options.token === 'string' && options.token !== ''
    ? options.token
    : randomBytes(24).toString('hex')
  const file = options.file || modelSettingsFile(options.home)
  const handle = (request) => serveModelSettings(request, {
    token,
    file,
    now: options.now,
    accountId: options.accountId ?? (() => resolveHostAccountId(ctx)),
  })

  const disposers = []
  disposers.push(webServer.register({
    kind: 'exact',
    path: MODEL_SETTINGS_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, handle) },
  }))

  if (typeof webServer.tapIndex === 'function') {
    const payload = JSON.stringify({
      version: MODEL_SETTINGS_VERSION,
      path: MODEL_SETTINGS_ROUTE,
      token,
    }).replace(/</g, '\\u003c')
    disposers.push(webServer.tapIndex((html) => {
      const script = '<script>window.' + MODEL_SETTINGS_BRIDGE_GLOBAL + '=' + payload + ';</script>'
      return html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html
    }))
  }

  const dispose = () => {
    for (const disposer of disposers) {
      try { disposer() } catch { /* 已随 ctx.effect 清理 */ }
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-limbs: model settings bridge')
  }
  return { route: MODEL_SETTINGS_ROUTE, file, dispose }
}

const TOOL_NAME = 'analyze_conversation_efficiency'
const DEFAULT_TOP_N = 3

/** 阈值集中在此，便于按真实数据校准（单位：字节 / 次数）。 */
const THRESHOLDS = {
  /** 单次工具结果超过此字节数，视为「未裁剪的超大结果」。 */
  hugeResultBytes: 30_000,
  /** 终端类工具的结果超过此字节数，视为「多余终端输出」。 */
  terminalBytes: 8_000,
  /** 文件读取类工具的结果超过此字节数且未指定 range，视为「全量读大文件」。 */
  fullReadBytes: 20_000,
  /** 同一签名（工具名 + 参数）重复出现达到此次数，视为循环 / 重试。 */
  repeatSignature: 3,
}

/** 工具名归类，用于把诊断挂到正确的行为上。 */
const TERMINAL_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'terminal', 'run_terminal', 'run_command'])
const READ_TOOLS = new Set(['read', 'read_file', 'fs_read', 'cat', 'view'])

// ─────────────────────────────────────────────────────────────────────
// 1. 数据获取
// ─────────────────────────────────────────────────────────────────────

/**
 * 从当前会话事件流提取工具调用明细与 token 用量。
 *
 * 只读：不 append、不改 surface、不触发 flush。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ id: string }} agent 调用方 Agent（其 id 即 SessionId）
 * @returns {object} 原始轨迹（fetchTraceData → analyzeData 的输入）
 */
export function fetchTraceData(ctx, agent) {
  if (!agent || typeof agent.id !== 'string') {
    throw new Error('缺少调用方 Agent，无法定位当前会话。')
  }
  const session = ctx.sessions.get(agent.id)
  if (!session) {
    throw new Error(`当前会话 ${agent.id} 不在内存 Session 注册表中（可能已归档或进程重启）。`)
  }

  const events = session.ownEvents()
  if (events.length === 0) {
    return {
      sessionId: session.id,
      cwd: session.header?.cwd,
      createdAt: session.header?.createdAt,
      eventCount: 0,
      seq: session.seq,
      steps: [],
      calls: [],
      usageSeries: [],
      projection: null,
    }
  }

  /** @type {Map<string, any>} key = `${turn}/${step}` */
  const steps = new Map()
  /** @type {any[]} */
  const calls = []
  /** @type {Map<string, any>} */
  const callByCallId = new Map()
  /** @type {any[]} 按 seq 顺序的 assistant/message 用量 */
  const usageSeries = []

  const stepKeyOf = (turn, step) => `${turn}/${step}`
  const ensureStep = (turn, step) => {
    const key = stepKeyOf(turn, step)
    let entry = steps.get(key)
    if (!entry) {
      entry = {
        key,
        turn,
        step,
        startTime: null,
        endTime: null,
        usage: null,
        calls: [],
        attemptedCalls: 0,
      }
      steps.set(key, entry)
    }
    return entry
  }

  for (const event of events) {
    switch (event.type) {
      case 'step/start':
        ensureStep(event.data.turn, event.data.step).startTime = event.time
        break

      case 'step/end': {
        ensureStep(event.data.turn, event.data.step).endTime = event.time
        break
      }

      case 'assistant/message': {
        const stepEntry = ensureStep(event.data.turn, event.data.step)
        const usage = event.data.usage ?? null
        stepEntry.usage = usage
        if (usage) {
          usageSeries.push({
            seq: event.seq,
            turn: event.data.turn,
            step: event.data.step,
            usage,
            interrupted: event.data.interrupted === true,
          })
        }
        break
      }

      case 'tool/call': {
        const stepEntry = ensureStep(event.data.turn, event.data.step)
        stepEntry.attemptedCalls += 1
        const record = {
          callId: String(event.data.callId),
          name: String(event.data.name),
          argumentsRaw: String(event.data.arguments ?? ''),
          turn: event.data.turn,
          step: event.data.step,
          seq: event.seq,
          time: event.time,
          durationMs: null,
          resultBytes: 0,
          resultTextBytes: 0,
          isError: false,
          errorCode: undefined,
          attributedInput: 0,
          attributedOutput: 0,
        }
        calls.push(record)
        callByCallId.set(record.callId, record)
        stepEntry.calls.push(record)
        break
      }

      case 'tool/result': {
        const message = event.data.message
        const callId = String(message?.toolCallId ?? message?.source?.callId ?? '')
        const record = callByCallId.get(callId)
        if (!record) break
        record.durationMs = Math.max(0, event.time - record.time)
        record.resultBytes = contentBytes(message?.content)
        record.resultTextBytes = contentTextBytes(message?.content)
        record.isError = message?.isError === true
        record.errorCode = event.data.error?.code
        break
      }

      default:
        break
    }
  }

  return {
    sessionId: session.id,
    cwd: session.header?.cwd,
    createdAt: session.header?.createdAt,
    eventCount: events.length,
    seq: session.seq,
    steps: orderSteps(steps),
    calls,
    usageSeries,
    projection: readContextProjection(ctx, session),
  }
}

/**
 * 读取 dsh-context 已算好的 `contextTimeline` 投影。
 *
 * 这是框架的公开 seam（`ctx.sessionProjections.snapshot` + 投影表扩展），
 * 不是逆向别人的私有实现。它直接提供三样事件流算不出来的东西：
 *
 *   - `costRead.usd`：按模型价格算好的美元金额（本模块不臆造汇率与单价）
 *   - `current.*`：上下文按「系统 / 工具定义 / 用户 / 注入 / 助手 / 工具结果」的构成
 *   - `timing.tools` / `commands[].outChars`：每工具耗时与终端输出字符数
 *
 * dsh-context 未安装、被禁用、键未注册或版本不匹配时一律返回 null，
 * 调用方退回事件流口径 —— 绝不因为第三方插件缺失而让分析崩掉。
 *
 * @returns {object|null} 归一化后的投影数据，不可用时为 null
 */
function readContextProjection(ctx, session) {
  const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (!projections || typeof projections.snapshot !== 'function') return null

  let snapshot
  try {
    snapshot = projections.snapshot(session, ['contextTimeline'])
  } catch {
    // 投影单元缺失、状态版本不匹配、schema 校验失败 —— 全部安静降级。
    return null
  }

  const timeline = snapshot?.values?.contextTimeline
  if (!timeline || typeof timeline !== 'object') return null

  return {
    asOfSeq: snapshot.asOfSeq,
    usd: typeof timeline.costRead?.usd === 'number' ? timeline.costRead.usd : null,
    usdReady: timeline.costRead?.ready === true,
    categories: normalizeCategories(timeline.current),
    toolTiming: timeline.timing?.tools ?? null,
    toolTally: timeline.toolTally ?? null,
    commands: Array.isArray(timeline.commands) ? timeline.commands : [],
    fileOps: Array.isArray(timeline.fileOps) ? timeline.fileOps : [],
    requestCount: Array.isArray(timeline.requests) ? timeline.requests.length : 0,
  }
}

/** 把投影的 `current` 收敛成本模块的类别表。 */
function normalizeCategories(current) {
  if (!current || typeof current !== 'object') return null
  const categories = {
    system: positiveInt(current.system),
    tools: positiveInt(current.tools),
    user: positiveInt(current.user),
    inject: positiveInt(current.inject),
    skill: positiveInt(current.skill),
    assistant: positiveInt(current.assistant),
    tool: positiveInt(current.tool),
  }
  const total = positiveInt(current.total)
    || Object.values(categories).reduce((sum, value) => sum + value, 0)
  return { ...categories, total }
}

/** ContentBlock[] 的序列化字节数（近似：按文本长度 + 图片/文件元数据）。 */
function contentBytes(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') total += block.text.length
    else if (block.attachment && typeof block.attachment.bytes === 'number') total += block.attachment.bytes
    else total += 32
  }
  return total
}

/** 只统计模型可见文本，用于「输出占了多少」的展示。 */
function contentTextBytes(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block && typeof block.text === 'string') total += block.text.length
  }
  return total
}

/** 按 (turn, step) 排序，保证差分口径与真实请求顺序一致。 */
function orderSteps(stepMap) {
  return [...stepMap.values()].sort((a, b) => (a.turn - b.turn) || (a.step - b.step))
}

// ─────────────────────────────────────────────────────────────────────
// 2. 分析：费用归因 + 效率诊断 + 评分
// ─────────────────────────────────────────────────────────────────────

/**
 * 对原始轨迹做归因与诊断。
 *
 * @param {object} trace fetchTraceData 的返回值
 * @param {{ topN?: number }} options
 * @returns {object} 结构化分析结果（generateMarkdown 的输入）
 */
export function analyzeData(trace, options = {}) {
  const topN = clampInt(options.topN ?? DEFAULT_TOP_N, 1, 10)

  // ── 2.1 用量总账 ──
  const totals = {
    requests: trace.usageSeries.length,
    steps: trace.steps.length,
    calls: trace.calls.length,
    errors: trace.calls.filter(call => call.isError).length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    baselineTokens: 0,
    attributedInput: 0,
    attributedOutput: 0,
    // 投影提供的金额与类别构成；未接入 dsh-context 时为 null。
    usd: trace.projection?.usd ?? null,
    usdReady: trace.projection?.usdReady === true,
    categories: trace.projection?.categories ?? null,
  }

  for (const entry of trace.usageSeries) {
    const usage = entry.usage
    totals.inputTokens += positiveInt(usage.inputTokens)
    totals.outputTokens += positiveInt(usage.outputTokens)
    totals.cacheReadTokens += positiveInt(usage.cacheReadTokens)
    totals.cacheWriteTokens += positiveInt(usage.cacheWriteTokens)
    totals.reasoningTokens += positiveInt(usage.reasoningTokens)
  }

  // ── 2.2 差分归因：第 N 步的 input 增量归给第 N-1 步的工具 ──
  const stepByKey = new Map(trace.steps.map(step => [step.key, step]))
  const unattributed = { label: '(无工具步骤)', input: 0, output: 0, requests: 0 }

  let previousInput = 0
  let previousStepKey = null
  let previousHadUsage = false

  for (const entry of trace.usageSeries) {
    const usage = entry.usage
    const inputTokens = positiveInt(usage.inputTokens)
    const outputTokens = positiveInt(usage.outputTokens)
    const key = `${entry.turn}/${entry.step}`
    const currentStep = stepByKey.get(key) ?? null

    if (!previousHadUsage) {
      // 第一次请求：整段前缀是系统提示 + 用户消息，不属于任何工具。
      totals.baselineTokens = inputTokens
    } else {
      const delta = Math.max(0, inputTokens - previousInput)
      const owners = previousStepKey ? (stepByKey.get(previousStepKey)?.calls ?? []) : []
      distributeAttribution(owners, delta, 'attributedInput', unattributed, 'input')
    }

    // 本步输出归本步的工具（模型为了发起这些调用而生成）。
    const ownCalls = currentStep?.calls ?? []
    distributeAttribution(ownCalls, outputTokens, 'attributedOutput', unattributed, 'output')

    previousInput = inputTokens
    previousStepKey = key
    previousHadUsage = true
  }

  totals.attributedInput = trace.calls.reduce((sum, call) => sum + call.attributedInput, 0)
  totals.attributedOutput = trace.calls.reduce((sum, call) => sum + call.attributedOutput, 0)
  totals.unattributedInput = unattributed.input
  totals.unattributedOutput = unattributed.output

  // ── 2.3 按工具归因 ──
  const byTool = new Map()
  for (const call of trace.calls) {
    let bucket = byTool.get(call.name)
    if (!bucket) {
      bucket = {
        name: call.name,
        calls: 0,
        errors: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        resultBytes: 0,
        durationMs: 0,
      }
      byTool.set(call.name, bucket)
    }
    bucket.calls += 1
    bucket.errors += call.isError ? 1 : 0
    bucket.inputTokens += call.attributedInput
    bucket.outputTokens += call.attributedOutput
    bucket.tokens += call.attributedInput + call.attributedOutput
    bucket.resultBytes += call.resultBytes
    bucket.durationMs += call.durationMs ?? 0
  }

  // 投影里的每工具耗时比事件流配对更准（事件流按 tool/call→tool/result 配对，
  // 投影按真实跨度统计），有就用投影的。
  const projectedTiming = trace.projection?.toolTiming
  if (projectedTiming) {
    for (const bucket of byTool.values()) {
      const timed = projectedTiming[bucket.name]
      if (timed && Number.isFinite(timed.ms)) bucket.durationMs = timed.ms
    }
  }

  const attributableTokens = Math.max(
    1,
    totals.attributedInput + totals.attributedOutput + totals.baselineTokens,
  )
  const toolRanking = [...byTool.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .map(bucket => ({
      ...bucket,
      share: bucket.tokens / attributableTokens,
    }))
  const topTools = toolRanking.slice(0, topN)

  // ── 2.4 效率诊断 ──
  const diagnostics = []

  // 死循环 / 重复重试：同名同参数达到阈值
  const signatureMap = new Map()
  for (const call of trace.calls) {
    const signature = `${call.name}|${normalizeArguments(call.argumentsRaw)}`
    let group = signatureMap.get(signature)
    if (!group) {
      group = { name: call.name, calls: [], steps: new Set() }
      signatureMap.set(signature, group)
    }
    group.calls.push(call)
    group.steps.add(`${call.turn}/${call.step}`)
  }
  for (const group of signatureMap.values()) {
    if (group.calls.length < THRESHOLDS.repeatSignature) continue
    const tokens = group.calls.reduce((sum, call) => sum + call.attributedInput + call.attributedOutput, 0)
    const bytes = group.calls.reduce((sum, call) => sum + call.resultBytes, 0)
    diagnostics.push({
      id: 'repeat-call',
      severity: group.calls.length >= THRESHOLDS.repeatSignature * 2 ? 'high' : 'medium',
      title: `重复调用：${group.name} × ${group.calls.length}`,
      detail:
        `同一工具、同一参数被调用了 ${group.calls.length} 次，横跨 ${group.steps.size} 步。`
        + '典型原因是参数没变却反复重试，或模型在等一个不会变的答案。',
      tokens,
      bytes,
      calls: group.calls,
    })
  }

  // 全量读大文件
  const fullReads = trace.calls.filter(call =>
    READ_TOOLS.has(call.name)
    && call.resultBytes >= THRESHOLDS.fullReadBytes
    && !hasRangeArgument(call.argumentsRaw))
  if (fullReads.length > 0) {
    diagnostics.push({
      id: 'full-read',
      severity: fullReads.length >= 3 ? 'high' : 'medium',
      title: `全量读大文件 × ${fullReads.length}`,
      detail:
        '这些读取没有带 offset / limit，结果整体灌进了上下文，并且会随每一轮请求重复计费。'
        + '先 grep 定位再按行读取，通常能省掉绝大部分。',
      tokens: sumAttributed(fullReads),
      bytes: fullReads.reduce((sum, call) => sum + call.resultBytes, 0),
      calls: fullReads,
    })
  }

  // 多余终端输出
  const terminalHeavy = trace.calls.filter(call =>
    TERMINAL_TOOLS.has(call.name) && call.resultBytes >= THRESHOLDS.terminalBytes)
  if (terminalHeavy.length > 0) {
    diagnostics.push({
      id: 'terminal-heavy',
      severity: 'medium',
      title: `终端输出过大 × ${terminalHeavy.length}`,
      detail:
        '命令把整屏输出带回了上下文。加 `| Select-Object -First N`、`--quiet`、'
        + '`2>$null` 之类的收口，结果长度会差一个数量级。',
      tokens: sumAttributed(terminalHeavy),
      bytes: terminalHeavy.reduce((sum, call) => sum + call.resultBytes, 0),
      calls: terminalHeavy,
    })
  }

  // 未裁剪的超大结果（不分工具）
  const hugeResults = trace.calls.filter(call => call.resultBytes >= THRESHOLDS.hugeResultBytes)
  if (hugeResults.length > 0) {
    diagnostics.push({
      id: 'huge-result',
      severity: 'medium',
      title: `单次结果 ≥ ${formatBytes(THRESHOLDS.hugeResultBytes)} × ${hugeResults.length}`,
      detail: '这些结果单条就越过了裁剪线，建议在产生端就限长，而不是靠后续压缩补救。',
      tokens: sumAttributed(hugeResults),
      bytes: hugeResults.reduce((sum, call) => sum + call.resultBytes, 0),
      calls: hugeResults,
    })
  }

  // 失败重试
  const erroredCalls = trace.calls.filter(call => call.isError)
  if (erroredCalls.length > 0) {
    diagnostics.push({
      id: 'tool-error',
      severity: erroredCalls.length >= 5 ? 'high' : 'low',
      title: `工具报错 × ${erroredCalls.length}`,
      detail: '报错本身不贵，贵的是报错之后原样重试的那几轮。',
      tokens: sumAttributed(erroredCalls),
      bytes: erroredCalls.reduce((sum, call) => sum + call.resultBytes, 0),
      calls: erroredCalls,
    })
  }

  diagnostics.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || b.tokens - a.tokens)

  // ── 2.5 效率评分 ──
  const deductions = []
  let score = 100
  const deductOnce = (reason, points) => {
    if (points <= 0) return
    score -= points
    deductions.push({ reason, points })
  }

  deductOnce(`工具报错 ${totals.errors} 次`, Math.min(20, totals.errors * 2))
  for (const item of diagnostics) {
    if (item.id === 'repeat-call') deductOnce(`重复调用 ${item.calls.length} 次`, Math.min(25, 8 * item.calls.length))
    if (item.id === 'full-read') deductOnce(`全量读大文件 ${item.calls.length} 次`, Math.min(20, 4 * item.calls.length))
    if (item.id === 'terminal-heavy') deductOnce(`终端输出过大 ${item.calls.length} 次`, Math.min(15, 3 * item.calls.length))
    if (item.id === 'huge-result') deductOnce(`超长结果 ${item.calls.length} 次`, Math.min(15, 3 * item.calls.length))
  }
  // 上下文膨胀：基准之外的平均每次增量
  if (totals.requests > 1 && totals.attributedInput > 0) {
    const perRequest = Math.round(totals.attributedInput / Math.max(1, totals.requests - 1))
    if (perRequest > 20_000) deductOnce(`平均每步新增上下文 ${formatTokens(perRequest)} tokens`, 10)
    else if (perRequest > 8_000) deductOnce(`平均每步新增上下文 ${formatTokens(perRequest)} tokens`, 5)
  }
  score = Math.max(0, Math.min(100, Math.round(score)))

  // ── 2.6 建议（含反向指导模块二）──
  const suggestions = buildSuggestions({ diagnostics, totals, toolRanking, score })

  return {
    sessionId: trace.sessionId,
    cwd: trace.cwd,
    createdAt: trace.createdAt,
    eventCount: trace.eventCount,
    totals,
    topTools,
    toolRanking,
    diagnostics,
    score: { value: score, deductions },
    suggestions,
    unattributed,
  }
}

/** 把一段 token 增量按结果体量分摊给多个工具调用；无调用则计入未归因桶。 */
function distributeAttribution(calls, amount, field, unattributed, kind) {
  if (amount <= 0) return
  if (!calls || calls.length === 0) {
    unattributed[kind] += amount
    return
  }
  const weightTotal = calls.reduce((sum, call) => sum + Math.max(1, call.resultBytes), 0)
  let assigned = 0
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const weight = Math.max(1, call.resultBytes) / weightTotal
    // 最后一个承接余数，避免浮点累计误差；夹到 0 以上，防止四舍五入把余数吃成负数。
    const share = index === calls.length - 1
      ? Math.max(0, amount - assigned)
      : Math.round(amount * weight)
    call[field] += share
    assigned += share
  }
}

/** 参数归一化：解析后按 key 排序再序列化，让「同一参数」判定稳定。 */
function normalizeArguments(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  try {
    return stableStringify(JSON.parse(text))
  } catch {
    return text.slice(0, 400)
  }
}

/** 稳定序列化（递归排序对象键）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** 参数里是否带了 range 语义（offset / limit / head / tail 之类）。 */
function hasRangeArgument(raw) {
  const text = String(raw ?? '')
  return /"(offset|limit|start|end|range|line|lines|head|tail)"/i.test(text)
}

function sumAttributed(calls) {
  return calls.reduce((sum, call) => sum + call.attributedInput + call.attributedOutput, 0)
}

function severityWeight(severity) {
  if (severity === 'high') return 3
  if (severity === 'medium') return 2
  if (severity === 'low') return 1
  return 0
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function clampInt(value, min, max) {
  const numeric = Number.isFinite(value) ? Math.round(value) : min
  return Math.max(min, Math.min(max, numeric))
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0B'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${Math.round(value)}B`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '0%'
  const value = ratio * 100
  if (value >= 10) return `${value.toFixed(0)}%`
  return `${value.toFixed(1)}%`
}

/** 生成可执行的建议，含「去模块二调档」这类跨模块动作。 */
function buildSuggestions({ diagnostics, totals, toolRanking, score }) {
  const suggestions = []
  const ids = new Set(diagnostics.map(item => item.id))
  const top = toolRanking[0]

  if (ids.has('full-read')) {
    suggestions.push({
      action: '先 grep 定位，再按行读取',
      why: '全量读大文件的结果会一直留在上下文里，每一轮都在为它重复付费。',
      expected: '同类会话通常可省 30%+ 输入 token',
    })
  }
  if (ids.has('terminal-heavy')) {
    suggestions.push({
      action: '终端命令加输出收口',
      why: '整屏输出进上下文，等于把无用日志按 token 单价买了下来。',
      expected: '单次结果可小一个数量级',
    })
  }
  if (ids.has('repeat-call')) {
    suggestions.push({
      action: '重复调用前先换参数或换工具',
      why: '同名同参反复调用不会得到不同答案，只会把同样的前缀再付一次钱。',
      expected: '直接砍掉重复轮次',
    })
  }
  if (ids.has('huge-result')) {
    suggestions.push({
      action: '在工具调用处限长，而不是事后压缩',
      why: '结果一旦进了历史，压缩只能补救，省不回已经付过的输入。',
      expected: '降低每步固定开销',
    })
  }
  if (top && top.share >= 0.35) {
    suggestions.push({
      action: `重点盯 ${top.name}`,
      why: `它吃掉了可归因费用的 ${formatPercent(top.share)}，是所有优化里回报最高的一个点。`,
      expected: `优先优化它，收益上限约 ${formatPercent(top.share)}`,
    })
  }
  if (score < 70) {
    suggestions.push({
      action: '到模块二下调这一步的推理强度',
      why: '评分偏低通常伴随反复试错，而试错阶段不需要最高推理档位。',
      expected: '在模块二的推理强度档位上直接生效',
    })
  }
  if (suggestions.length === 0) {
    suggestions.push({
      action: '保持现状',
      why: '本次会话没有命中任何浪费模式，继续用当前习惯即可。',
      expected: '无需调整',
    })
  }
  return suggestions
}

// ─────────────────────────────────────────────────────────────────────
// 3. 渲染：Markdown 诊断报告
// ─────────────────────────────────────────────────────────────────────

/**
 * 把分析结果渲染成 Markdown。
 *
 * @param {object} analysis analyzeData 的返回值
 * @returns {string} Markdown 文本
 */
export function generateMarkdown(analysis) {
  const { totals, topTools, diagnostics, score, suggestions } = analysis
  const lines = []

  // 章节号自适应：没有投影数据时不占号，读者不会看到跳号。
  const numerals = ['一', '二', '三', '四', '五', '六', '七']
  let sectionCursor = 0
  const section = title => `### ${numerals[sectionCursor++]}、${title}`

  lines.push('## 会话复盘 · 效率诊断')
  lines.push('')
  lines.push(`> 会话 \`${shortId(analysis.sessionId)}\` · 事件 ${analysis.eventCount} 条`
    + ` · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push('')

  // ── 总览 ──
  lines.push(section('总账'))
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('|---|---|')
  lines.push(`| 模型请求 | ${totals.requests} 次（${totals.steps} 步） |`)
  lines.push(`| 工具调用 | ${totals.calls} 次，其中报错 ${totals.errors} 次 |`)
  lines.push(`| 输入 token | ${formatTokens(totals.inputTokens)} |`)
  lines.push(`| 输出 token | ${formatTokens(totals.outputTokens)} |`)
  if (totals.cacheReadTokens > 0) {
    lines.push(`| 缓存命中 | ${formatTokens(totals.cacheReadTokens)}（仅展示，不参与归因） |`)
  }
  lines.push(`| 起始上下文 | ${formatTokens(totals.baselineTokens)}（系统提示 + 首条消息，不属于任何工具） |`)
  lines.push(`| 可归因 token | ${formatTokens(totals.attributedInput + totals.attributedOutput)}（工具引起的增量） |`)
  if (totals.usd !== null) {
    lines.push(`| 费用 | $${totals.usd.toFixed(4)}${totals.usdReady ? '' : '（价格匹配中，暂不完整）'} |`)
  }
  lines.push('')
  lines.push('> **口径**：输入 token 按「本次 − 上次」差分归因到上一步的工具，'
    + '输出 token 直接归本步工具。整段前缀不重复计入。')
  lines.push('')

  // ── 大头归因 ──
  lines.push(section('费用大头'))
  lines.push('')
  if (topTools.length === 0 || topTools.every(item => item.tokens === 0)) {
    lines.push('_本次会话没有产生可归因的工具费用。_')
    lines.push('')
  } else {
    lines.push('| # | 工具 | token | 占比 | 调用 | 结果体量 | 平均耗时 |')
    lines.push('|---|---|---|---|---|---|---|')
    topTools.forEach((item, index) => {
      const average = item.calls > 0 ? item.durationMs / item.calls : 0
      lines.push(`| ${index + 1} | \`${item.name}\` | ${formatTokens(item.tokens)} | `
        + `${formatPercent(item.share)} ${bar(item.share)} | ${item.calls} | `
        + `${formatBytes(item.resultBytes)} | ${formatDuration(average)} |`)
    })
    lines.push('')
    if (analysis.toolRanking.length > topTools.length) {
      const rest = analysis.toolRanking.length - topTools.length
      lines.push(`_榜单只列前 ${topTools.length} 个，另有 ${rest} 个工具未列出。_`)
      lines.push('')
    }
  }
  if (analysis.unattributed.input + analysis.unattributed.output > 0) {
    lines.push(`_另有 ${formatTokens(analysis.unattributed.input + analysis.unattributed.output)} tokens`
      + ' 落在「没有工具参与的纯对话步骤」上，不计入工具排名。_')
    lines.push('')
  }

  // ── 上下文构成（来自 dsh-context 的 contextTimeline 投影）──
  if (totals.categories && totals.categories.total > 0) {
    const categoryRows = [
      ['系统提示', totals.categories.system],
      ['工具定义', totals.categories.tools],
      ['用户输入', totals.categories.user],
      ['注入内容', totals.categories.inject],
      ['技能', totals.categories.skill],
      ['历史助手回复', totals.categories.assistant],
      ['工具结果', totals.categories.tool],
    ]
    const categoryTotal = totals.categories.total
    lines.push(section('上下文构成'))
    lines.push('')
    lines.push('| 类别 | token | 占比 |')
    lines.push('|---|---|---|')
    for (const [label, value] of categoryRows) {
      if (value <= 0) continue
      lines.push(`| ${label} | ${formatTokens(value)} | `
        + `${formatPercent(value / categoryTotal)} ${bar(value / categoryTotal)} |`)
    }
    lines.push(`| **合计** | **${formatTokens(categoryTotal)}** | 100% |`)
    lines.push('')
    lines.push('> 数据来自 `dsh-context` 的 `contextTimeline` 投影。'
      + '「工具结果」这一行就是每一轮请求都在为历史工具输出重复付费的部分。')
    lines.push('')
  }

  // ── 诊断 ──
  lines.push(section('效率诊断'))
  lines.push('')
  if (diagnostics.length === 0) {
    lines.push('未发现明显的浪费模式。')
    lines.push('')
  } else {
    // 同一批调用常同时命中多条规则（「全量读大文件」往往也是「重复调用」）。
    // 第二条起标注覆盖关系，避免读者把两行的 token 加在一起来看。
    const covered = new Set()
    for (const item of diagnostics) {
      const owned = (item.calls ?? []).map(call => call.callId)
      const overlaps = owned.length > 0 && owned.every(callId => covered.has(callId))
      for (const callId of owned) covered.add(callId)
      const suffix = overlaps ? '　_（与上一条为同一批调用，不重复计入）_' : ''
      lines.push(`- ${severityBadge(item.severity)} **${item.title}**`
        + ` — 约 ${formatTokens(item.tokens)} tokens / ${formatBytes(item.bytes)}${suffix}`)
      lines.push(`  - ${item.detail}`)
    }
    lines.push('')
  }

  // ── 评分 ──
  lines.push(section('效率评分'))
  lines.push('')
  lines.push(`**${score.value} / 100** ${scoreBar(score.value)}`)
  lines.push('')
  if (score.deductions.length > 0) {
    lines.push('扣分明细：')
    lines.push('')
    for (const item of score.deductions) {
      lines.push(`- −${item.points}　${item.reason}`)
    }
    lines.push('')
  }

  // ── 建议 ──
  lines.push(section('优化建议'))
  lines.push('')
  suggestions.forEach((item, index) => {
    lines.push(`${index + 1}. **${item.action}**`)
    lines.push(`   - 为什么：${item.why}`)
    lines.push(`   - 预期：${item.expected}`)
  })
  lines.push('')
  lines.push('---')
  lines.push('_本报告由 dsh-limbs 模块三基于本会话事件日志离线生成，不发起任何模型请求。_')
  if (totals.categories) {
    lines.push('_金额与上下文构成取自 `dsh-context` 的 `contextTimeline` 投影；'
      + '该插件不可用时会自动退回纯事件流口径。_')
  }

  return lines.join('\n')
}

function shortId(value) {
  const text = String(value ?? '')
  return text.length > 12 ? `${text.slice(0, 8)}…` : text
}

function bar(ratio) {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)))
  return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '`'
}

function scoreBar(value) {
  const filled = Math.max(0, Math.min(20, Math.round((value / 100) * 20)))
  return '`' + '█'.repeat(filled) + '░'.repeat(20 - filled) + '`'
}

function severityBadge(severity) {
  if (severity === 'high') return '🔴 高'
  if (severity === 'medium') return '🟠 中'
  return '🟡 低'
}

// ─────────────────────────────────────────────────────────────────────
// 4. 注册
// ─────────────────────────────────────────────────────────────────────

/** 输出契约：模型看到的是一段 Markdown 文本。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    '复盘当前会话的工具调用与 token 消耗，给出费用大头归因、效率诊断、评分和可执行的优化建议。'
    + '纯只读分析：不修改会话、不发模型请求。',
  parameters: {
    type: 'object',
    properties: {
      top_n: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: '费用归因榜单长度，默认 3。',
      },
    },
  },
  output: TEXT_OUTPUT,
  timeoutMs: 20_000,
  isConcurrencySafe: () => true,
}

/**
 * 复盘一次会话，返回 Markdown 报告。工具与命令共用这一条路径。
 *
 * @param {object} ctx
 * @param {{ id: string }} agent
 * @param {number} [topN]
 * @returns {string} Markdown
 */
export function reviewConversation(ctx, agent, topN = DEFAULT_TOP_N) {
  const trace = fetchTraceData(ctx, agent)
  return generateMarkdown(analyzeData(trace, { topN: clampInt(topN, 1, 10) }))
}

/** `/limbs-review [top_n]` 的人类入口定义。 */
const COMMAND_DEFINITION = {
  name: 'limbs-review',
  description: '复盘本会话的工具调用与 token 消耗：费用大头、效率诊断、评分与优化建议。',
  input: { hint: '[top_n] 归因榜单长度，默认 3' },
}

/**
 * 挂载：注册分析工具与 `/limbs-review` 命令。
 *
 * `ctx` 通过闭包进入两个入口 —— ToolRunContext 与 CommandInvocation 上
 * **都没有** ctx，不能从执行上下文里取服务。
 */
export function apply(ctx) {
  ctx.tools.register({
    ...TOOL_DEFINITION,
    execute: async (args, exec) => reviewConversation(ctx, exec?.agent, args?.top_n ?? DEFAULT_TOP_N),
  })

  ctx.commands.register({
    ...COMMAND_DEFINITION,
    handler: invocation => {
      // 命令直接面向人，不走模型：失败也必须给出一句能读懂的话，而不是抛出。
      const requested = Number.parseInt(String(invocation.rawInput ?? '').trim(), 10)
      const topN = Number.isFinite(requested) ? requested : DEFAULT_TOP_N
      try {
        return { kind: 'success', text: reviewConversation(ctx, invocation.agent, topN) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `复盘失败：${message}` }
      }
    },
  })

  // 模块二：档位设置的服务端保存接口。webServer 缺席时静默跳过，
  // 模块一（模型座位）与模块三（复盘）的行为完全不受影响。
  try {
    createModelSettingsBridge(ctx)
  } catch (error) {
    console.error('[dsh-limbs] 档位保存接口挂载失败', error)
  }

  // 模块八：项目管理（配置链路）。两条只碰 `.dsh/handoff.yaml` 的窄接口，
  // 令牌 + 同源校验 + 原子落盘，做法照模块二、落点跟模块七。挂不上也只降级。
  try {
    createHandoffConfigBridge(ctx)
  } catch (error) {
    console.error('[dsh-limbs] 模块八（项目管理配置接口）挂载失败', error)
  }

  // 模块七：窗口交接。三段里本轮只上 assemble（只读注入）+ lookup（只读检索）
  // + commit 的 dry-run；**不写任何工程文件**。整段挂载失败也只降级，不连累
  // 模块一/二/三 —— 与上面档位接口同一个容错口径。
  try {
    mountHandoff(ctx)
  } catch (error) {
    console.error('[dsh-limbs] 模块七（交接）挂载失败', error)
  }
}

/**
 * 模块七的挂载点：工具（lookup / commit dry-run）+ `agent/pre-step` 装配器。
 *
 * ⚠️ **为什么不是 `ctx.systemPrompt.section()`**：那个 API 没有 cwd、注册是全局的，
 * 拿它做按项目注入会把 A 项目的任务账注进 B 项目（MODULE7 §5.1 / §八#5）。
 * 走 `agent/pre-step` 才能读到 `agent.session.header.cwd`。
 *
 * @param {object} ctx
 */
export function mountHandoff(ctx) {
  const { disposers } = applyHandoffTools(ctx)

  if (typeof ctx.on === 'function') {
    const { listener } = createHandoffAssembler()
    const off = ctx.on('agent/pre-step', listener)
    if (typeof off === 'function') disposers.push(off)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已随 ctx.effect 清理 */ }
      }
    }, 'dsh-limbs: handoff (module 7)')
  }
  return disposers
}
