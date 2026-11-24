/**
 * Host half of dsh-limbs — 模块八 · 项目管理（配置链路）。
 *
 * 这一份只做一件事：**给模块八的 UI 开两条窄接口**，读写项目级
 * `.dsh/handoff.yaml`，并把单项目的只读摘要拼出来。
 *
 *   GET  /limbs/handoff-config            项目列表 + 每个项目摘要 + 全局默认（只读）
 *   GET  /limbs/handoff-config?path=…     单个项目的生效配置（项目级覆盖后的结果）
 *   PUT  /limbs/handoff-config            写该项目级覆盖（原子落盘）
 *   GET  /limbs/handoff-project?path=…    单项目只读详情：账表 / §3.3 / STATUS 快照 / devlog 列表
 *   GET  /limbs/handoff-project?path=…&id=t-…  取某份 devlog 正文
 *   GET  /limbs/handoff-bridge            令牌引导（只回令牌 + 两条路由名）
 *
 * ── 为什么照模块二抄、而不是复用 `serveModelSettings` ─────────────────
 *
 * 模块二的接口按「账号桶」存 `<DSH_HOME>/dsh-limbs/model-settings.json`；
 * 本模块的数据**必须落项目里**（U5：插件全局安装，配置必须跟项目走，
 * 否则多项目串话）。两者落点、键空间、冲突语义都不同，混成一个处理函数
 * 只会把模块二的 409 语义带歪。所以**同一套做法，另开一组路由**：
 * 令牌 + 同源校验 + 原子落盘（临时文件 + rename）。
 *
 * ── 谁能写 ────────────────────────────────────────────────────────────
 *
 * 优先只认 DSH 已登记的工作区（`ctx.get('workspaceRegistry').list()`），
 * 这正是「项目管理套官方工作区壳子」的落点。未注册的路径放行条件是：
 * 绝对路径、无 `..`、且目录下已有 `PROJECT_PROGRESS.md` 或 `.dsh/handoff.yaml`
 * —— 即「这目录本来就长得像个项目」。放行的写入范围**只有**
 * `<path>/.dsh/handoff.yaml` 一个文件，不会写到别处。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  DEFAULT_HANDOFF_CONFIG,
  HANDOFF_CONFIG_PATH,
  LEDGER_RECENT_LIMIT,
  parseHandoffYaml,
  parseLedgerRows,
  parsePendingDecisions,
  parseStatusCheckedAt,
  parseStatusSnapshot,
  parseDevlogSections,
  resolveHandoffConfig,
  TASK_ID_PATTERN,
} from './handoff.js'

// ─────────────────────────────────────────────────────────────────────
// 0. 常量与路由名
// ─────────────────────────────────────────────────────────────────────

export const HANDOFF_CONFIG_ROUTE = '/limbs/handoff-config'
export const HANDOFF_PROJECT_ROUTE = '/limbs/handoff-project'

/**
 * 令牌引导接口（**只回令牌与两条路由名**，不碰任何项目数据）。
 *
 * 为什么要有它：index 注入（`tapIndex`）只在 Host 渲染 index.html 时生效，
 * 而桌面端可能用自带文档服务给出 index、或浏览器垫一层缓存 —— 那时页面全局
 * 里就没有 `__DSH_LIMBS_HANDOFF__`，UI 会一直显示「Host 接口没挂上」。
 * 实测就是这么出现的（模块八第一次真机目视，段 2）。
 *
 * 它凭什么算安全：① 只允许 **GET**；② 与数据接口同一套**同源校验**
 * （跨站来源一律 403，且响应不带 CORS 头，其他站读不到内容）；
 * ③ 返回的令牌只能用于本插件那两条窄接口，而它们各自还有自己的令牌 + 同源
 * 两道闸。最坏情况 = 「能看到本机 DSH 页面的人」能读到令牌 —— 而他本来就能
 * 通过页面 UI 改这些配置。
 */
export const HANDOFF_BRIDGE_ROUTE = '/limbs/handoff-bridge'

/** 页面侧从 index 注入里读到的桥接全局（与模块二的 `__DSH_LIMBS_BRIDGE__` 分开）。 */
export const HANDOFF_BRIDGE_GLOBAL = '__DSH_LIMBS_HANDOFF__'

const TOKEN_HEADER = 'x-limbs-token'
const MAX_BODY = 16 * 1024

/** 配置项清单：**只认这四个**（`inject` 是模块八新增的第一诉求）。 */
export const HANDOFF_CONFIG_KEYS = ['inject', 'write', 'ledgerRecent', 'checkCommand']

const DEVLOG_NAME = /^t-(\d{8})-(\d{2})_(.*)\.md$/
const PROGRESS_FILE = 'PROJECT_PROGRESS.md'
const STATUS_FILE = 'PROJECT_STATUS.md'
const DEVLOG_DIR = 'Docs/devlog'

// ─────────────────────────────────────────────────────────────────────
// 1. 小工具
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

/**
 * 桌面端自己的文档 origin。DSH Desktop 的页面跑在 `dsh-app://app`（见
 * `resources/app.asar/lib/main.js` 的 `protocol.handle(SCHEME)`），它把
 * `/limbs/*` 这类非静态请求转发给 Host 并附上 Host 的 cookie；但转发时
 * 保留 `Origin: dsh-app://app`。如果只按「与请求 URL 同 host」判同源，
 * 桌面端每一个请求都会被判成跨站 → 403，模块八的页面便会显示
 * 「Host 接口没挂上」而路由其实是活的（段 2 真机目视碰到的那次）。
 *
 * 放行它的代价：`dsh-app://app` 只有桌面外壳的主窗口能发出（webRequest
 * 过滤器把其他来源的 ws 请求直接 cancel，协议处理器也只服务这个 host）。
 * 换句话说，它与「本机 DSH 页面」是同一个信任域，不是新开的外来入口。
 */
const TRUSTED_APP_ORIGINS = ['dsh-app://app']

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

/** 路径比较：Windows 上大小写与分隔符都不敏感；只比字面规范化形式。 */
export function samePath(a, b) {
  const normalize = value => String(value ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  return normalize(a) === normalize(b)
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. 项目级配置的读写
// ─────────────────────────────────────────────────────────────────────

/**
 * 把生效配置渲染成 `.dsh/handoff.yaml` 正文。
 *
 * **只写与全局默认不同的项**：项目级文件是「覆盖层」，不是全集快照 ——
 * 缺项即继承 `DEFAULT_HANDOFF_CONFIG`（`readHandoffConfig` 已如此实现）。
 * 这样默认值将来改了，没显式覆盖过的项目自动跟着变。
 *
 * ⚠️ 值里出现 `#` 时**不写**（`parseHandoffYaml` 会把它当注释截断，
 * 写进去读回来就不是同一个值了）。调用方负责先校验并给出可读原因。
 *
 * @param {object} config 已经 `resolveHandoffConfig` 收敛过的配置
 * @returns {string}
 */
export function renderHandoffYaml(config) {
  const lines = [
    '# 模块七/八 · 窗口交接与项目管理的**项目级覆盖**（本文件不入库，见 .gitignore）',
    '# 缺项 = 继承代码里的 DEFAULT_HANDOFF_CONFIG；只写与默认不同的项。',
    '#',
    '#   inject       热注入开关（默认 true）',
    '#   write        真写总开关（默认 false）',
    '#   ledgerRecent 账表滑窗行数（默认 ' + LEDGER_RECENT_LIMIT + '）',
    '#   checkCommand 写后自检命令（默认空 = 自动探测 check-docs.ps1 / check_docs.py）',
    '',
  ]
  const value = config ?? {}
  if (value.inject !== DEFAULT_HANDOFF_CONFIG.inject) {
    lines.push('inject: ' + (value.inject === true ? 'true' : 'false'))
  }
  if (value.write !== DEFAULT_HANDOFF_CONFIG.write) {
    lines.push('write: ' + (value.write === true ? 'true' : 'false'))
  }
  if (value.ledgerRecent !== DEFAULT_HANDOFF_CONFIG.ledgerRecent) {
    lines.push('ledgerRecent: ' + Number(value.ledgerRecent))
  }
  if (typeof value.checkCommand === 'string' && value.checkCommand !== DEFAULT_HANDOFF_CONFIG.checkCommand) {
    lines.push('checkCommand: ' + value.checkCommand.trim())
  }
  return lines.join('\n') + '\n'
}

/**
 * 原子写项目级配置：同目录临时文件 → rename。失败时不留半截文件。
 *
 * @param {string} root 项目根
 * @param {object} config 已收敛的配置
 * @returns {Promise<{path: string, text: string}>}
 */
export async function writeProjectHandoffConfig(root, config) {
  const file = join(resolve(root), HANDOFF_CONFIG_PATH)
  const text = renderHandoffYaml(config)
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
  return { path: file, text }
}

/**
 * 读项目级配置并给出**每项值的来源**（项目覆盖 / 全局默认）。
 *
 * @param {string} root
 * @returns {Promise<{path: string, exists: boolean, config: object, defaults: object,
 *   warnings: string[], sources: Record<string, 'project'|'default'>, raw: object}>}
 */
export async function readProjectHandoffConfig(root) {
  const path = join(resolve(root), HANDOFF_CONFIG_PATH)
  const text = await readTextIfExists(path)
  const raw = text === null ? {} : parseHandoffYaml(text)
  const resolved = resolveHandoffConfig(raw)
  const sources = {}
  for (const key of HANDOFF_CONFIG_KEYS) {
    sources[key] = Object.prototype.hasOwnProperty.call(raw, key) ? 'project' : 'default'
  }
  return {
    path,
    exists: text !== null,
    config: resolved.config,
    defaults: DEFAULT_HANDOFF_CONFIG,
    warnings: resolved.warnings,
    sources,
    raw,
  }
}

/**
 * 校验 PUT 提交的配置片段。
 *
 * 只接受 `HANDOFF_CONFIG_KEYS` 里的四个键；坏值给**可读中文原因**，
 * 不做「静默回退默认值」—— 静默回退会让用户以为存进去了。
 *
 * ⚠️ **返回的是补丁，不是全集**：只含 input 里真正出现的键。
 * 早期版本从 `{...DEFAULT_HANDOFF_CONFIG}` 起算再覆盖，于是「只改 inject」
 * 的一次 PUT 会把没提交的 `write` 一并写成默认 `false` —— 真机上刚点一下
 * 热注入开关，本项目的 `write: true` 就被抹掉了。补丁必须只含提交的键。
 *
 * @param {unknown} input
 * @returns {{ok: true, patch: object} | {ok: false, code: string, message: string}}
 */
export function validateConfigPatch(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'config', message: '缺少配置内容。' }
  }
  for (const key of Object.keys(input)) {
    if (!HANDOFF_CONFIG_KEYS.includes(key)) {
      return { ok: false, code: 'config', message: `未知配置项 ${key}（只支持 ${HANDOFF_CONFIG_KEYS.join(' / ')}）。` }
    }
  }
  const patch = {}
  if ('inject' in input) {
    if (typeof input.inject !== 'boolean') {
      return { ok: false, code: 'config', message: 'inject 必须是布尔值（true / false）。' }
    }
    patch.inject = input.inject
  }
  if ('write' in input) {
    if (typeof input.write !== 'boolean') {
      return { ok: false, code: 'config', message: 'write 必须是布尔值（true / false）。' }
    }
    patch.write = input.write
  }
  if ('ledgerRecent' in input) {
    const value = Number(input.ledgerRecent)
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return { ok: false, code: 'config', message: 'ledgerRecent 必须是 1–100 的整数。' }
    }
    patch.ledgerRecent = value
  }
  if ('checkCommand' in input) {
    if (typeof input.checkCommand !== 'string') {
      return { ok: false, code: 'config', message: 'checkCommand 必须是字符串。' }
    }
    const trimmed = input.checkCommand.trim()
    if (trimmed.length > 200) {
      return { ok: false, code: 'config', message: 'checkCommand 太长（上限 200 字符）。' }
    }
    if (trimmed.includes('#')) {
      // 既有 YAML 解析器把 `#` 当行内注释起点：写进去读回来会截断，
      // 所以宁可在保存时明确拒绝，也不留「保存成功但值变了」的假象。
      return { ok: false, code: 'config', message: 'checkCommand 里不能有 #（会被项目级 YAML 解析器当注释截断）。' }
    }
    patch.checkCommand = trimmed
  }
  return { ok: true, patch }
}

// ─────────────────────────────────────────────────────────────────────
// 3. 单项目摘要（一级页要的「每个项目摘要」）
// ─────────────────────────────────────────────────────────────────────

/**
 * 一个项目的摘要：账表条数 / 最近一次收尾 id / 真写是否开着。
 *
 * 「最近一次收尾」= 账表里**最后一条有冷存档的账行**（`存档` 列不是 `—`）。
 * 模块级的父任务行没有 devlog，把它的 id 当「最近收尾」会误导。
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function readProjectSummary(root) {
  const configRead = await readProjectHandoffConfig(root)
  const progress = await readTextIfExists(join(resolve(root), PROGRESS_FILE))
  const rows = parseLedgerRows(progress ?? '')
  let latestArchiveId = null
  for (const row of rows) {
    if (row.archive !== '—' && row.archive !== '' && TASK_ID_PATTERN.test(row.id)) latestArchiveId = row.id
  }
  if (latestArchiveId === null && rows.length > 0) latestArchiveId = rows[rows.length - 1].id

  let devlogCount = 0
  try {
    const names = await readdir(join(resolve(root), DEVLOG_DIR))
    devlogCount = names.filter(name => DEVLOG_NAME.test(name)).length
  } catch { /* 目录缺失按 0 计 */ }

  return {
    root: resolve(root),
    title: null,
    hasProgress: progress !== null,
    ledgerRows: rows.length,
    latestArchiveId,
    devlogCount,
    config: configRead.config,
    configExists: configRead.exists,
    configSources: configRead.sources,
    configWarnings: configRead.warnings,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. 单项目只读详情（二级页要的四块 + devlog 列表）
// ─────────────────────────────────────────────────────────────────────

/**
 * 二级页的只读数据。**全部只读**：不写盘、不跑自检、不动账表。
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function readProjectDetail(root) {
  const base = resolve(root)
  const progress = await readTextIfExists(join(base, PROGRESS_FILE))
  const status = await readTextIfExists(join(base, STATUS_FILE))
  const decisions = parsePendingDecisions(progress ?? '')

  const devlogs = []
  try {
    for (const name of await readdir(join(base, DEVLOG_DIR))) {
      const match = DEVLOG_NAME.exec(name)
      if (match === null) continue
      const info = await stat(join(base, DEVLOG_DIR, name)).catch(() => null)
      devlogs.push({
        id: `t-${match[1]}-${match[2]}`,
        name,
        title: match[3],
        modifiedAt: info === null ? null : Math.round(info.mtimeMs),
      })
    }
  } catch { /* 目录缺失 = 空列表 */ }
  // 按 id 倒序（`t-` 前缀让字典序 = 时间序）
  devlogs.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))

  return {
    root: base,
    ledgerRows: parseLedgerRows(progress ?? ''),
    pending: decisions.pending,
    decided: decisions.decided,
    statusSnapshot: parseStatusSnapshot(status ?? ''),
    statusCheckedAt: parseStatusCheckedAt(status ?? ''),
    devlogs,
    hasProgress: progress !== null,
    hasStatus: status !== null,
  }
}

/**
 * 取一份 devlog 正文（按 id）。找不到给**可读原因**，不是空串。
 *
 * @param {string} root
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function readProjectDevlog(root, id) {
  const base = resolve(root)
  const wanted = String(id ?? '').trim()
  if (!TASK_ID_PATTERN.test(wanted)) {
    return { found: false, id: wanted, reason: `id 格式应为 t-YYYYMMDD-NN（收到 ${JSON.stringify(wanted)}）` }
  }
  let names
  try {
    names = await readdir(join(base, DEVLOG_DIR))
  } catch {
    return { found: false, id: wanted, reason: 'Docs/devlog 目录不存在' }
  }
  const name = names.find(item => item.startsWith(wanted + '_') && item.endsWith('.md'))
  if (name === undefined) {
    const progress = await readTextIfExists(join(base, PROGRESS_FILE))
    const onLedger = parseLedgerRows(progress ?? '').some(row => row.id === wanted)
    return {
      found: false,
      id: wanted,
      reason: onLedger
        ? '账表里有这个 id，但没有对应的冷存档（`存档` 列应为 `—`：未开工任务）'
        : '账表和 Docs/devlog 里都没有这个 id',
    }
  }
  const text = await readTextIfExists(join(base, DEVLOG_DIR, name))
  return {
    found: text !== null,
    id: wanted,
    name,
    text,
    sections: text === null ? null : parseDevlogSections(text),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. 谁能被读写：工作区白名单 + 项目形态兜底
// ─────────────────────────────────────────────────────────────────────

/**
 * 解析一个路径是否允许模块八读写。
 *
 * 判定顺序（**先注册表，再项目形态**）：
 *   ① 命中 `workspaceRegistry.list()` 的路径 → 放行（`registered: true`）
 *   ② 未注册但「绝对路径 + 无 .. + 目录里已有 PROJECT_PROGRESS.md 或 .dsh/handoff.yaml」
 *      → 放行（`registered: false`，响应里明示「不是已登记工作区」）
 *   ③ 其余一律拒绝，给可读原因
 *
 * 放行后的写入范围**只有** `<path>/.dsh/handoff.yaml`。
 *
 * @param {string} projectPath
 * @param {{list?: () => Array<{id?: string, path: string, title?: string}>}} [registry]
 * @returns {Promise<{ok: true, root: string, title: string|null, workspaceId: string|null,
 *   registered: boolean} | {ok: false, code: string, message: string}>}
 */
export async function resolveProjectPath(projectPath, registry) {
  const raw = String(projectPath ?? '').trim()
  if (raw === '') return { ok: false, code: 'path', message: '缺少项目路径（path）。' }
  if (!isAbsolute(raw)) return { ok: false, code: 'path', message: '项目路径必须是绝对路径。' }
  const segments = raw.split(/[\\/]+/)
  if (segments.includes('..')) return { ok: false, code: 'path', message: '项目路径不能含 ..' }
  const root = resolve(raw)

  let listed = []
  if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
    try {
      listed = registry.list()
    } catch {
      listed = []
    }
  }
  const hit = listed.find(item => samePath(item?.path, root))
  if (hit !== undefined && hit !== null) {
    return {
      ok: true,
      root: resolve(hit.path),
      title: typeof hit.title === 'string' && hit.title !== '' ? hit.title : null,
      workspaceId: typeof hit.id === 'string' ? hit.id : null,
      registered: true,
    }
  }

  // ② 未注册：只认「本来就长得像项目」的目录，避免把任意路径当写入目标。
  let isDirectory = false
  try {
    isDirectory = (await stat(root)).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    return { ok: false, code: 'missing', message: '这个路径不存在或不是目录。' }
  }
  const looksLikeProject = await exists(join(root, PROGRESS_FILE))
    || await exists(join(root, HANDOFF_CONFIG_PATH))
  if (!looksLikeProject) {
    return {
      ok: false,
      code: 'unregistered',
      message: '该目录既不是 DSH 工作区，也没有 PROJECT_PROGRESS.md / .dsh/handoff.yaml，'
        + '看起来不是项目；先在侧栏把它建成工作区再来。',
    }
  }
  return { ok: true, root, title: null, workspaceId: null, registered: false }
}

// ─────────────────────────────────────────────────────────────────────
// 6. 两条路由的处理函数（纯函数，离线测试直接构造 Fetch Request）
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET/PUT /limbs/handoff-config`。
 *
 * @param {Request} request
 * @param {object} options
 * @param {string} options.token 必须匹配的访问令牌
 * @param {object} [options.registry] 工作区注册表（`{list()}`），缺席 = 只能按项目形态放行
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function serveHandoffConfig(request, options) {
  const token = options?.token
  if (typeof token !== 'string' || token === ''
    || request.headers.get(TOKEN_HEADER) !== token) {
    return jsonResponse(403, { ok: false, code: 'forbidden', message: '没有权限读写项目配置。' })
  }
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { ok: false, code: 'cross-origin', message: '跨站请求已拒绝。' })
  }

  const url = new URL(request.url)
  const wanted = url.searchParams.get('path')

  if (request.method === 'GET') {
    if (wanted === null || wanted.trim() === '') {
      // 一级页：项目列表 + 摘要 + 全局默认（全部只读）。
      const listed = []
      let fallback = null
      const registry = options?.registry
      if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
        try {
          for (const item of registry.list()) listed.push(item)
        } catch { /* 注册表读不了 = 空列表 */ }
      } else {
        fallback = 'workspace-registry-missing'
      }
      const projects = []
      for (const item of listed) {
        const root = String(item?.path ?? '')
        if (root === '') continue
        try {
          const summary = await readProjectSummary(root)
          projects.push({
            ...summary,
            title: typeof item?.title === 'string' && item.title !== '' ? item.title : (summary.title ?? root),
            workspaceId: typeof item?.id === 'string' ? item.id : null,
            registered: true,
            error: null,
          })
        } catch (error) {
          projects.push({
            root,
            title: typeof item?.title === 'string' && item.title !== '' ? item.title : root,
            workspaceId: typeof item?.id === 'string' ? item.id : null,
            registered: true,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return jsonResponse(200, {
        ok: true,
        projects,
        defaults: DEFAULT_HANDOFF_CONFIG,
        fallback,
      })
    }

    const resolved = await resolveProjectPath(wanted, options?.registry)
    if (!resolved.ok) {
      return jsonResponse(400, { ok: false, code: resolved.code, message: resolved.message })
    }
    const configRead = await readProjectHandoffConfig(resolved.root)
    return jsonResponse(200, {
      ok: true,
      path: resolved.root,
      title: resolved.title,
      workspaceId: resolved.workspaceId,
      registered: resolved.registered,
      configPath: configRead.path,
      configExists: configRead.exists,
      config: configRead.config,
      sources: configRead.sources,
      warnings: configRead.warnings,
      defaults: DEFAULT_HANDOFF_CONFIG,
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
  if (text.length > MAX_BODY) {
    return jsonResponse(413, { ok: false, code: 'body', message: '请求内容过大。' })
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return jsonResponse(400, { ok: false, code: 'json', message: '请求内容不是合法 JSON。' })
  }
  if (body === null || typeof body !== 'object') {
    return jsonResponse(400, { ok: false, code: 'body', message: '请求内容应为对象。' })
  }
  const targetPath = body.path ?? wanted
  const resolved = await resolveProjectPath(targetPath, options?.registry)
  if (!resolved.ok) {
    return jsonResponse(400, { ok: false, code: resolved.code, message: resolved.message })
  }

  const patch = body.config ?? body.patch
  const validation = validateConfigPatch(patch)
  if (!validation.ok) {
    return jsonResponse(400, { ok: false, code: validation.code, message: validation.message })
  }

  const current = await readProjectHandoffConfig(resolved.root)
  // 只把**提交了的键**合并进生效配置；未提交的项保留其原有来源
  // （可能是项目覆盖，也可能是继承默认）。见 validateConfigPatch 的注释。
  const next = { ...current.config, ...validation.patch }
  try {
    await writeProjectHandoffConfig(resolved.root, next)
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      code: 'io',
      message: '写盘失败：' + (error instanceof Error ? error.message : String(error)),
    })
  }
  const after = await readProjectHandoffConfig(resolved.root)
  return jsonResponse(200, {
    ok: true,
    path: resolved.root,
    title: resolved.title,
    workspaceId: resolved.workspaceId,
    registered: resolved.registered,
    configPath: after.path,
    configExists: after.exists,
    config: after.config,
    sources: after.sources,
    warnings: after.warnings,
    defaults: DEFAULT_HANDOFF_CONFIG,
  })
}

/**
 * `GET /limbs/handoff-project`：单项目只读详情 / 某份 devlog 正文。
 *
 * @param {Request} request
 * @param {object} options
 * @param {string} options.token
 * @param {object} [options.registry]
 * @returns {Promise<Response>}
 */
export async function serveHandoffProject(request, options) {
  const token = options?.token
  if (typeof token !== 'string' || token === ''
    || request.headers.get(TOKEN_HEADER) !== token) {
    return jsonResponse(403, { ok: false, code: 'forbidden', message: '没有权限读取项目详情。' })
  }
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { ok: false, code: 'cross-origin', message: '跨站请求已拒绝。' })
  }
  if (request.method !== 'GET') {
    return jsonResponse(405, { ok: false, code: 'method', message: '只支持读取。' }, { allow: 'GET, HEAD' })
  }

  const url = new URL(request.url)
  const wanted = url.searchParams.get('path')
  const id = url.searchParams.get('id')
  const resolved = await resolveProjectPath(wanted, options?.registry)
  if (!resolved.ok) {
    return jsonResponse(400, { ok: false, code: resolved.code, message: resolved.message })
  }

  if (id !== null && id.trim() !== '') {
    const found = await readProjectDevlog(resolved.root, id)
    return jsonResponse(200, {
      ok: true,
      path: resolved.root,
      title: resolved.title,
      registered: resolved.registered,
      devlog: found,
    })
  }

  const detail = await readProjectDetail(resolved.root)
  const configRead = await readProjectHandoffConfig(resolved.root)
  return jsonResponse(200, {
    ok: true,
    path: resolved.root,
    title: resolved.title,
    workspaceId: resolved.workspaceId,
    registered: resolved.registered,
    configPath: configRead.path,
    configExists: configRead.exists,
    config: configRead.config,
    configSources: configRead.sources,
    configWarnings: configRead.warnings,
    defaults: DEFAULT_HANDOFF_CONFIG,
    detail,
  })
}

// ─────────────────────────────────────────────────────────────────────
// 7. 挂载到 webServer
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET /limbs/handoff-bridge`：给页面回**令牌与两条路由名**，别的什么都不给。
 *
 * 只回 GET、只认同源；令牌本身仍要过 `x-limbs-token` + 同源的二次校验。
 *
 * @param {Request} request
 * @param {{token: string}} options
 * @returns {Response}
 */
export function serveHandoffBridge(request, options) {
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
  return jsonResponse(200, {
    ok: true,
    token,
    configPath: HANDOFF_CONFIG_ROUTE,
    projectPath: HANDOFF_PROJECT_ROUTE,
  })
}

/** 读请求体的 Node 适配（PUT 用）。 */
function readRequestBody(request, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求内容过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => { resolveBody(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}

async function nodeHandler(req, res, handle, route) {
  try {
    const host = req.headers.host || '127.0.0.1'
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (typeof value === 'string') headers.set(name, value)
    }
    const method = req.method || 'GET'
    const body = method === 'PUT' ? await readRequestBody(req) : undefined
    const request = new Request(`http://${host}${req.url || route}`, { method, headers, body })
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

/**
 * 挂载模块八的两条 Host 接口 + index 注入（令牌）。
 *
 * webServer 缺席时静默降级，不影响模块一/二/三/七。
 *
 * @param {object} ctx Host ctx
 * @param {object} [options]
 * @returns {{routes: string[], dispose: () => void}|undefined}
 */
export function createHandoffConfigBridge(ctx, options = {}) {
  const webServer = options.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return undefined

  const token = typeof options.token === 'string' && options.token !== ''
    ? options.token
    : randomBytes(24).toString('hex')

  // 工作区注册表：可选服务，缺席 = 只能按「项目形态」放行（并明示未登记）。
  const registry = () => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      return service !== null && service !== undefined && typeof service.list === 'function' ? service : undefined
    } catch {
      return undefined
    }
  }

  const configHandler = request => serveHandoffConfig(request, { token, registry: registry() })
  const projectHandler = request => serveHandoffProject(request, { token, registry: registry() })
  const bridgeHandler = request => serveHandoffBridge(request, { token })

  const disposers = []
  disposers.push(webServer.register({
    kind: 'exact',
    path: HANDOFF_CONFIG_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, configHandler, HANDOFF_CONFIG_ROUTE) },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: HANDOFF_PROJECT_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, projectHandler, HANDOFF_PROJECT_ROUTE) },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: HANDOFF_BRIDGE_ROUTE,
    handler: (req, res) => { void nodeHandler(req, res, bridgeHandler, HANDOFF_BRIDGE_ROUTE) },
  }))

  if (typeof webServer.tapIndex === 'function') {
    const payload = JSON.stringify({
      token,
      configPath: HANDOFF_CONFIG_ROUTE,
      projectPath: HANDOFF_PROJECT_ROUTE,
    }).replace(/</g, '\\u003c')
    disposers.push(webServer.tapIndex((html) => {
      const script = '<script>window.' + HANDOFF_BRIDGE_GLOBAL + '=' + payload + ';</script>'
      return html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html
    }))
  }

  // ⚠️ 桌面端不经过 Host 渲染 index.html：它自己从 dist 取文档，再通过
  // `dshDesktopBoot.ready()` 拿回 Host 收集的**结构化注入行**（页面侧 iG()
  // 逐行 apply，`kind: 'global'` 就是 `globalThis[name] = value`）。
  // 因此 `tapIndex` 那段在桌面端是**无效**的 —— 模块八第一次真机目视就是
  // 页面显示「Host 接口没挂上」而 Host 的路由其实活着。
  // 正解是用官方事件把同一份 payload 作为 global 行推进注入表。
  if (typeof ctx.on === 'function') {
    const payload = { token, configPath: HANDOFF_CONFIG_ROUTE, projectPath: HANDOFF_PROJECT_ROUTE }
    const off = ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      table.push({ kind: 'global', name: HANDOFF_BRIDGE_GLOBAL, value: payload })
    })
    if (typeof off === 'function') disposers.push(off)
  }

  const dispose = () => {
    for (const disposer of disposers) {
      try { disposer() } catch { /* 已随 ctx.effect 清理 */ }
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-limbs: handoff config bridge (module 8)')
  }
  return { routes: [HANDOFF_CONFIG_ROUTE, HANDOFF_PROJECT_ROUTE, HANDOFF_BRIDGE_ROUTE], token, dispose }
}
