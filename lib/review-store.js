/**
 * Host half of dsh-limbs — 模块三 · 复盘报告的落盘与读回（B2）。
 *
 * 这一份只做一件事：把复盘报告变成「会话切走、DSH 重启之后还在」的事实。
 *
 *   <DSH_HOME>/dsh-limbs/reviews/<sessionId>.md     报告正文（纯 Markdown）
 *
 * ── 为什么正文里不写时间戳 ──────────────────────────────────────────────
 *
 * 「生成于 <时间>」取自**文件的 mtime**，正文保持纯报告 —— 这样人用任何
 * Markdown 阅读器打开都是干净的，也省掉一层 frontmatter 解析和它的腐坏面。
 * （重新复盘 = 覆盖写，mtime 随之更新，这正是「最新一次」的语义。）
 *
 * ── 清理（必须实现，否则永久增长）──────────────────────────────────────
 *
 * 保留条件：**最近 `REVIEW_KEEP_COUNT` 份** 或 **`REVIEW_KEEP_DAYS` 天内**。
 * 两个条件任一满足就留，两条都不满足的才删（按 mtime 从旧到新删）。
 * 每次写盘后跑一次；判据集中在这两个常量里，别散到别处。
 *
 * ── 为什么状态目录不查 workspaceRoot ────────────────────────────────────
 *
 * `ctx.get('sandboxPolicy').resolve()` 的 `workspaceRoot` 是**工作区**边界，
 * 而这目录是插件自己的状态目录（与模块二的 `model-settings.json`、
 * 模块七的 `handoff-tokens.json` 同一层），本来就在工作区之外。
 * 所以这里只看 `mode`：`read-only` 一律不写（fail-safe）。
 *
 * ── 读回为什么走 HTTP 路由，不是命令通道 ────────────────────────────────
 *
 * `ctx.commands.register` 的回包只有 `success` / `error` 两种，`text` 会直接
 * 渲染进对话 —— 用一条隐藏命令把 JSON 喂给面板，等于每次读盘都在对话里
 * 留一段没人要的输出。所以读回开一条只读 GET（令牌 + 同源 + index 注入），
 * 做法照模块八的 `handoff-config.js`（桌面端注入坑那边已经踩过并解决了）。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────────
// 0. 常量与路由名
// ─────────────────────────────────────────────────────────────────────

export const REVIEW_ROUTE = '/limbs/review'
export const REVIEW_BRIDGE_ROUTE = '/limbs/review-bridge'

/** 页面侧从 index 注入里读到的桥接全局（与模块二 / 八的全局分开）。 */
export const REVIEW_BRIDGE_GLOBAL = '__DSH_LIMBS_REVIEW__'

/** 清理判据：最近多少份 / 多少天内的保留。这两个常量就是策略真源。 */
export const REVIEW_KEEP_COUNT = 20
export const REVIEW_KEEP_DAYS = 30

/** 状态子目录（`<DSH_HOME>/dsh-limbs/reviews`）。 */
const REVIEW_DIR_NAME = 'reviews'
const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN_HEADER = 'x-limbs-token'
/** 文件名里注入的会话 id 最长保留多少字符（Windows 路径长度上限）。 */
const MAX_NAME_LENGTH = 64

/** 桌面主窗口 origin，与模块八同一份信任域（见 `handoff-config.js` 的注释）。 */
const TRUSTED_APP_ORIGINS = ['dsh-app://app']

// ─────────────────────────────────────────────────────────────────────
// 1. 路径
// ─────────────────────────────────────────────────────────────────────

/**
 * 报告目录：`ctx.get('dshHomePath')` 优先，缺失时退回 `DSH_HOME`。
 *
 * ⚠️ **不退回系统临时目录**：那等于「重启就丢」，正是 B2 要解决的事
 * （模块二 `modelSettingsFile()` 的 tmpdir 回退就是这个反面样本）。
 *
 * @param {object} ctx Host ctx
 * @returns {string} 绝对路径
 */
export function reviewsDir(ctx) {
  if (typeof ctx?.get === 'function') {
    try {
      const resolveHome = ctx.get('dshHomePath')
      if (typeof resolveHome === 'function') return resolveHome('dsh-limbs', REVIEW_DIR_NAME)
    } catch { /* 服务缺席，走回退 */ }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'dsh-limbs', REVIEW_DIR_NAME)
  return join(process.cwd(), '.dsh', 'dsh-limbs', REVIEW_DIR_NAME)
}

/**
 * 会话 id → 文件名。
 *
 * 真实的会话 id 可能是 `session:<uuid>` 这种带冒号的形态，而 `:` 在 Windows
 * 文件名里非法 —— 所以把 `[A-Za-z0-9._-]` 之外一律压成单个 `-`。
 * **读与写共用这一个函数**，所以不需要反向映射，也不会两边算出不同文件名。
 *
 * @param {string} sessionId
 * @returns {string} `<sanitized>.md`
 */
export function reviewFileName(sessionId) {
  const raw = String(sessionId ?? '').trim()
  const safe = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
  return (safe === '' ? 'unknown-session' : safe) + '.md'
}

/** 某个会话的报告文件绝对路径（不保证存在）。 */
export function reviewFile(ctx, sessionId) {
  return resolve(join(reviewsDir(ctx), reviewFileName(sessionId)))
}

// ─────────────────────────────────────────────────────────────────────
// 2. 写 / 读
// ─────────────────────────────────────────────────────────────────────

/** 原子写：同目录临时文件 → rename。失败时不留半截文件。 */
async function writeAtomically(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

/**
 * 落盘一份报告（覆盖同名旧文件 = 「重新复盘」），随后按策略清理旧文件。
 *
 * @param {object} ctx Host ctx
 * @param {string} sessionId
 * @param {string} markdown
 * @param {{now?: () => number, keepCount?: number, keepDays?: number}} [options]
 * @returns {Promise<{path: string, name: string, generatedAt: number, pruned: string[]}>}
 */
export async function saveReviewReport(ctx, sessionId, markdown, options = {}) {
  const file = reviewFile(ctx, sessionId)
  await writeAtomically(file, String(markdown ?? ''))
  const info = await stat(file)
  // 清理失败不该让「报告没存上」这个假象出现 —— 删不掉就留着，下一轮再试。
  let pruned = []
  try {
    pruned = await pruneReviewReports(ctx, options)
  } catch { pruned = [] }
  return {
    path: file,
    name: reviewFileName(sessionId),
    // mtime 就是「生成于」的唯一真源（见文件头注释）。
    generatedAt: Math.round(info.mtimeMs),
    pruned,
  }
}

/**
 * 读回一份报告。找不到给 `found: false`（不是抛错 —— 面板据此显示空态）。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{found: boolean, path: string, markdown: string|null, generatedAt: number|null}>}
 */
export async function readReviewReport(ctx, sessionId) {
  const file = reviewFile(ctx, sessionId)
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { found: true, path: file, markdown: text, generatedAt: Math.round(info.mtimeMs) }
  } catch {
    return { found: false, path: file, markdown: null, generatedAt: null }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. 清理（保留最近 N 份 或 M 天内；两条都不满足才删）
// ─────────────────────────────────────────────────────────────────────

/** 列出目录里的报告文件（只认 `.md`；`*.tmp` 一律不碰）。 */
async function listReviewFiles(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      out.push({ name, path, mtimeMs: Math.round(info.mtimeMs) })
    } catch { /* 单个文件读不到就跳过，不连累整轮清理 */ }
  }
  return out
}

/**
 * 按策略清理旧报告。
 *
 * 判据（两个常量即策略）—— **保留必须同时满足两条**：
 *   ① 落在「最近 `keepCount` 份」之内（数量硬上限）
 *   ② 落在「`keepDays` 天」之内（时间上限）
 *   任一条不满足就删，从最旧的开始。
 *
 * 为什么不是「或」：需求里两条验收同时存在 —— 「超 20 份时删最旧」
 * 与「30 天内」。只有「且」能同时满足两者，也只有「且」能同时封住
 * **数量**与**时间**两个方向的增长（「或」会让一天里连跑 30 次复盘就留下
 * 30 份，同一天里 100 次就是 100 份 —— 那正是「永久增长」本身）。
 *
 * @param {object} ctx
 * @param {{now?: () => number, keepCount?: number, keepDays?: number}} [options]
 * @returns {Promise<string[]>} 删掉的文件名
 */
export async function pruneReviewReports(ctx, options = {}) {
  const now = typeof options.now === 'function' ? Number(options.now()) : Date.now()
  const keepCount = Number.isInteger(options.keepCount) && options.keepCount > 0
    ? options.keepCount
    : REVIEW_KEEP_COUNT
  const keepDays = Number.isFinite(options.keepDays) && options.keepDays >= 0
    ? options.keepDays
    : REVIEW_KEEP_DAYS
  const dir = reviewsDir(ctx)
  const files = await listReviewFiles(dir)
  // 按 mtime 倒序（新的在前）；同一毫秒按名字定序，保证同一输入总是同一结果。
  files.sort((left, right) => right.mtimeMs - left.mtimeMs
    || (left.name < right.name ? 1 : left.name > right.name ? -1 : 0))

  const cutoff = now - keepDays * DAY_MS
  const doomed = []
  files.forEach((entry, index) => {
    // ① 最近 keepCount 份以内：这条满足
    const withinCount = index < keepCount
    // ② keepDays 天以内：这条满足
    const withinDays = entry.mtimeMs >= cutoff
    // 两条都要满足才留 —— 缺一条就删。
    if (withinCount && withinDays) return
    doomed.push(entry.name)
  })
  for (const name of doomed) {
    try {
      await unlink(join(dir, name))
    } catch { /* 删不掉就留着，下一轮再试；不抛给调用方 */ }
  }
  return doomed
}

// ─────────────────────────────────────────────────────────────────────
// 4. 权限档（只看 mode）
// ─────────────────────────────────────────────────────────────────────

/**
 * 读当前会话的权限档。
 *
 * @param {object} ctx
 * @param {object} [session]
 * @returns {string|null} `read-only` / `workspace-write` / `danger-full-access` / `null`（拿不到）
 */
export function reviewPolicyMode(ctx, session) {
  const service = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  if (service === undefined || service === null || typeof service.resolve !== 'function') return null
  try {
    const policy = service.resolve(session === undefined ? {} : { session })
    const mode = String(policy?.mode ?? '')
    return mode === '' ? null : mode
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. 带闸的保存（唯一给工具/命令用的入口）
// ─────────────────────────────────────────────────────────────────────

/**
 * 生成之后顺手落盘。**任何失败都只降级，绝不连累报告本身。**
 *
 * 三道判据：
 *   ① 权限档拿不到 → 不写（fail-safe，与模块七同一口径）
 *   ② `read-only` → 不写，并给出可读原因（面板会把它显示成一句提示）
 *   ③ 写盘/清理抛错 → 吞掉，`saved: false`
 *
 * @param {object} ctx Host ctx
 * @param {{id: string}} agent 当前 Agent（其 id 即 SessionId）
 * @param {string} markdown
 * @param {{session?: object, now?: () => number, keepCount?: number, keepDays?: number}} [options]
 * @returns {Promise<{saved: boolean, path: string|null, generatedAt: number|null,
 *   pruned: string[], reason: string}>}
 */
export async function saveReviewSafely(ctx, agent, markdown, options = {}) {
  const sessionId = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : ''
  if (sessionId === '') {
    return { saved: false, path: null, generatedAt: null, pruned: [], reason: '没有会话标识，报告没有落盘' }
  }
  // 会话对象从 ctx 取：权限档要按**本会话**算，不是进程默认值。
  let session = options.session
  if (session === undefined && typeof ctx?.sessions?.get === 'function') {
    try { session = ctx.sessions.get(sessionId) } catch { session = undefined }
  }
  const mode = reviewPolicyMode(ctx, session)
  if (mode === null) {
    return {
      saved: false,
      path: null,
      generatedAt: null,
      pruned: [],
      reason: '拿不到 sandboxPolicy，无法确认权限档，本次没有落盘（fail-safe：宁可不写）',
    }
  }
  if (mode === 'read-only') {
    return {
      saved: false,
      path: null,
      generatedAt: null,
      pruned: [],
      reason: '当前会话是只读（read-only），报告没有落盘；切成 workspace-write 后再复盘就会存下来',
    }
  }
  try {
    const saved = await saveReviewReport(ctx, sessionId, markdown, options)
    return { saved: true, ...saved, reason: '' }
  } catch (error) {
    return {
      saved: false,
      path: null,
      generatedAt: null,
      pruned: [],
      reason: '写盘失败（报告仍可正常查看）：' + (error instanceof Error ? error.message : String(error)),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. HTTP：一条只读 GET + 一条令牌引导
// ─────────────────────────────────────────────────────────────────────

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

/** 同源、桌面主窗口 origin，或没有 Origin（非浏览器客户端）才放行。 */
function isSameOrigin(request) {
  const origin = request.headers.get('origin')
  if (origin === null || origin === 'null') return true
  if (TRUSTED_APP_ORIGINS.includes(origin)) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

function tokenOk(request, options) {
  const token = options?.token
  return typeof token === 'string' && token !== ''
    && request.headers.get(TOKEN_HEADER) === token
}

/**
 * `GET /limbs/review?session=<id>`：读回某个会话已落盘的报告。
 *
 * 没有报告时回 `found: false` + 200 —— 这是正常空态，不是错误
 * （面板据此显示「还没有报告」，不该把它画成红色告警）。
 *
 * @param {Request} request
 * @param {{token: string, ctx: object}} options
 * @returns {Promise<Response>}
 */
export async function serveReviewReport(request, options) {
  if (!tokenOk(request, options)) {
    return jsonResponse(403, { ok: false, code: 'forbidden', message: '没有权限读取复盘报告。' })
  }
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { ok: false, code: 'cross-origin', message: '跨站请求已拒绝。' })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(405, { ok: false, code: 'method', message: '只支持读取。' }, { allow: 'GET, HEAD' })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId.trim() === '') {
    return jsonResponse(400, { ok: false, code: 'session', message: '缺少会话标识（session）。' })
  }
  const read = await readReviewReport(options.ctx, sessionId)
  return jsonResponse(200, {
    ok: true,
    sessionId,
    found: read.found,
    markdown: read.markdown,
    generatedAt: read.generatedAt,
    name: reviewFileName(sessionId),
  })
}

/**
 * `GET /limbs/review-bridge`：只回令牌与路由名。
 *
 * 与模块八同一个理由 —— 桌面端不经过 Host 渲染 index.html，页面全局可能
 * 是空的（症状是页面显示「接口没挂上」而路由其实是活的）。
 *
 * @param {Request} request
 * @param {{token: string}} options
 * @returns {Response}
 */
export function serveReviewBridge(request, options) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { ok: false, code: 'cross-origin', message: '跨站请求已拒绝。' })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(405, { ok: false, code: 'method', message: '只支持读取。' }, { allow: 'GET, HEAD' })
  }
  const token = options?.token
  if (typeof token !== 'string' || token === '') {
    return jsonResponse(503, { ok: false, code: 'token', message: '桥接令牌尚未生成。' })
  }
  return jsonResponse(200, { ok: true, token, reportPath: REVIEW_ROUTE, keepCount: REVIEW_KEEP_COUNT })
}

/** 把 Node 的 req/res 适配成 Fetch Request/Response，复用同一套处理函数。 */
async function nodeHandler(req, res, handle, route) {
  try {
    const host = req.headers.host || '127.0.0.1'
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (typeof value === 'string') headers.set(name, value)
    }
    const request = new Request(`http://${host}${req.url || route}`, { method: req.method || 'GET', headers })
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
    res.end(JSON.stringify({
      ok: false,
      code: 'internal',
      message: '服务端处理失败：' + (error instanceof Error ? error.message : String(error)),
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. 挂载
// ─────────────────────────────────────────────────────────────────────

/**
 * 挂载复盘报告的两条 Host 接口 + index 注入（令牌）。
 *
 * webServer 缺席时静默降级：面板退化成「只能生成、读不回」，
 * 模块一/二/三/七/八的行为都不受影响。
 *
 * @param {object} ctx Host ctx
 * @param {object} [options]
 * @returns {{routes: string[], token: string, dispose: () => void}|undefined}
 */
export function createReviewStore(ctx, options = {}) {
  const webServer = options.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return undefined

  const token = typeof options.token === 'string' && options.token !== ''
    ? options.token
    : randomBytes(24).toString('hex')

  const reportHandler = request => serveReviewReport(request, { token, ctx })
  const bridgeHandler = request => serveReviewBridge(request, { token })

  const disposers = []
  disposers.push(webServer.register({
    kind: 'exact',
    path: REVIEW_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, reportHandler, REVIEW_ROUTE) },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: REVIEW_BRIDGE_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, bridgeHandler, REVIEW_BRIDGE_ROUTE) },
  }))

  if (typeof webServer.tapIndex === 'function') {
    const payload = JSON.stringify({ token, reportPath: REVIEW_ROUTE }).replace(/</g, '\\u003c')
    disposers.push(webServer.tapIndex((html) => {
      const script = '<script>window.' + REVIEW_BRIDGE_GLOBAL + '=' + payload + ';</script>'
      return html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html
    }))
  }

  // ⚠️ 桌面端不经过 Host 渲染 index.html（模块八真机踩过），必须再用
  // 官方事件把同一份 payload 作为 `kind: 'global'` 行推进注入表。
  if (typeof ctx.on === 'function') {
    const payload = { token, reportPath: REVIEW_ROUTE }
    const off = ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      table.push({ kind: 'global', name: REVIEW_BRIDGE_GLOBAL, value: payload })
    })
    if (typeof off === 'function') disposers.push(off)
  }

  const dispose = () => {
    for (const disposer of disposers) {
      try { disposer() } catch { /* 已随 ctx.effect 清理 */ }
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-limbs: review store bridge (module 3)')
  }
  return { routes: [REVIEW_ROUTE, REVIEW_BRIDGE_ROUTE], token, dispose }
}
