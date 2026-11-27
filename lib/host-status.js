/**
 * Host 半侧的挂载诊断（模块二 / 三 / 八共用）。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 *
 * 2026-11-27 真机症状：复盘面板显示「报告没有落盘：读不回落盘文件（本会话是
 * 只读权限，或 Host 接口没挂上）」、项目管理显示「Host 接口没挂上（webServer
 * 缺席或插件未启用）…HTTP 404」。实测 `/limbs/*` **五条路由全部 404**，而
 * 插件条目状态是 `schema`、包目录也解析到了 —— 也就是「插件是活的，路由一条
 * 没挂」。
 *
 * 根因是 **`ctx.get('webServer')` 在插件 fiber 里返回 undefined**：cordis 的
 * 服务是 fiber 提供的，跨 fiber 读一个没写进 `inject` 声明的服务拿不到实例
 * （这条失败面本工程 2026-11-16 就在 `.dev/RUNTIME-CHECK.md` 记过一版，当时
 * 是 `sessionProjections`）。而三个桥的挂载点都是
 *
 *     const webServer = ctx.get('webServer')
 *     if (webServer === undefined) return undefined   ← 静默降级
 *
 * 于是「拿不到 → 静默 return」，面板只能给出三个并列的猜测。
 *
 * ── 这个文件负责什么 ──────────────────────────────────────────────
 *
 * 只做一件事：把「每个桥到底挂上了没有」写成磁盘上的一份 JSON，供重启后
 * 一条命令复查。它**不参与业务**，也**不是**新的真源 —— 路由名与令牌仍是
 * 各模块自己的常量，这里只记「谁失败、为什么失败」。
 *
 * 落点 `<DSH_HOME>/dsh-limbs/host-status.json`，与模块二的
 * `model-settings.json`、模块七的 `handoff-tokens.json`、模块三的
 * `reviews/` 同一层。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 诊断文件格式版本（结构变了就抬，让读方知道怎么解释）。 */
export const HOST_STATUS_VERSION = 1

/** 状态文件里的三个桥位（与模块号一一对应，别改名 —— 脚本按它数）。 */
export const HOST_BRIDGES = Object.freeze(['modelSettings', 'review', 'handoff'])

/**
 * 状态目录：与 `review-store.js` 的 `reviewsDir` 同一口径 ——
 * `ctx.get('dshHomePath')` 优先，缺失回退 `DSH_HOME`，**不退回 tmpdir**。
 *
 * @param {object} ctx Host ctx
 * @returns {string} 绝对路径
 */
export function hostStatusDir(ctx) {
  if (typeof ctx?.get === 'function') {
    try {
      const resolveHome = ctx.get('dshHomePath')
      if (typeof resolveHome === 'function') return resolveHome('dsh-limbs')
    } catch { /* 服务缺席，走回退 */ }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'dsh-limbs')
  return join(process.cwd(), '.dsh', 'dsh-limbs')
}

/** 诊断文件绝对路径。 */
export function hostStatusFile(ctx) {
  return join(hostStatusDir(ctx), 'host-status.json')
}

/**
 * 建一个诊断记录器：**同步累积**，**异步落盘**。
 *
 * 为什么是同步累积 + 异步落盘：`apply()` 是同步函数，挂载点都要在同一轮里
 * 记完；但写盘是 IO，不该把插件启动拖住。所以每次 `record()` 只更新内存
 * 快照并排一个写盘任务，写完就覆盖（诊断文件只保留最新一次，不追加 ——
 * 追加会长成日志，而这里要的就是「现在是什么状态」）。
 *
 * @param {object} ctx Host ctx
 * @param {{now?: () => number, file?: string}} [options]
 * @returns {{record: Function, setWebServer: Function, flush: () => Promise<void>,
 *   snapshot: () => object, file: string}}
 */
export function createHostStatusRecorder(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  // 测试可以指定落点：**绝不能**让一次离线测试把真机那份诊断覆盖成
  // 「pending」—— 那正好会长成一张误导人的假现场。
  const explicitFile = typeof options.file === 'string' && options.file !== ''
  const file = explicitFile ? options.file : hostStatusFile(ctx)
  // 只有真实 Cordis ctx（带 `fiber`）才落盘。离线测试用的是普通对象假 ctx，
  // 它们跑在另一个进程里，写同一个 DSH_HOME 会把真机那份盖成假数据。
  // 显式给了 `file` 才强制写（那条只给测试自己的临时目录用）。
  const persistent = explicitFile
    || (ctx !== null && ctx !== undefined && ctx.fiber !== undefined && ctx.fiber !== null)
  const startedAt = now()

  /** 每个桥的当前状态。`pending` = 还没轮到它，`mounted` = 路由已注册。 */
  const bridges = {}
  for (const name of HOST_BRIDGES) bridges[name] = { status: 'pending', routes: [] }

  let webServer = 'pending'
  let lastError = null
  let chain = Promise.resolve()

  const snapshot = () => ({
    version: HOST_STATUS_VERSION,
    writtenAt: now(),
    pid: process.pid,
    startedAt,
    // 让复查脚本能一眼看出「这份诊断是哪个进程写的」，而不是跨重启比对错人。
    hostFile: import.meta.url,
    webServer,
    bridges: JSON.parse(JSON.stringify(bridges)),
    error: lastError,
  })

  const flush = () => {
    if (!persistent) return Promise.resolve()
    // 单条写盘链：并发 record() 不会互相覆盖出半截文件。
    chain = chain
      .then(async () => {
        const text = JSON.stringify(snapshot(), null, 2) + '\n'
        await mkdir(dirname(file), { recursive: true })
        const temporary = file + '.' + process.pid + '.tmp'
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, file)
      })
      .catch(() => { /* 诊断写不出来不能连累插件本体 */ })
    return chain
  }

  /**
   * 记一条。
   * @param {string} name `HOST_BRIDGES` 里的桥位
   * @param {{status: 'mounted'|'skipped'|'error', routes?: string[], reason?: string}} state
   */
  const record = (name, state) => {
    if (Object.prototype.hasOwnProperty.call(bridges, name)) {
      bridges[name] = {
        status: state.status,
        routes: Array.isArray(state.routes) ? state.routes.slice() : [],
        ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
      }
    }
    if (state.status === 'error' && typeof state.reason === 'string') lastError = name + ': ' + state.reason
    void flush()
  }

  /** 记 webServer 本身取到没取到 —— 这是所有桥的前置条件。 */
  const setWebServer = (state, reason) => {
    webServer = state
    if (state === 'missing' && typeof reason === 'string') lastError = 'webServer: ' + reason
    void flush()
  }

  // 第一笔立刻落盘：即便之后 webServer 一直不出现，磁盘上也有一份
  // 「pending」可读 —— 那正是「插件活着但接口没挂」这个状态的证据。
  void flush()

  return { record, setWebServer, flush, snapshot, file }
}
