/**
 * Host 三桥挂载的离线回归（模块二 / 三 / 八 的 `/limbs/*` 路由）。
 *
 * ── 这个测试守的是 2026-11-27 真机那个故障 ─────────────────────────────
 *
 * 症状：插件条目 `status: schema`、包目录解析正常、`analyze_conversation_efficiency`
 * 工具在、`/limbs-review` 命令在，但 `/limbs/*` **五条路由全部 404**，于是
 * 复盘面板说「读不回落盘文件（只读权限或 Host 接口没挂上）」、项目管理说
 * 「Host 接口没挂上…HTTP 404」。
 *
 * 根因：三个桥都在 `apply()` 里当场 `ctx.get('webServer')`，拿到的若是
 * `undefined` 就 `return undefined` 静默降级，而 `apply()` 一辈子只跑一次。
 *
 * 修法：走 `ctx.inject(['webServer'], cb)` —— 等 webServer 激活后再挂。
 *
 * 判据（本文件断言的四条，缺一条都算没修好）：
 *   ① webServer **迟到**（apply 时还没有）→ 回调补跑 → 路由真的注册上；
 *   ② webServer **永远缺席** → apply 不抛错、其余模块照常（工具/命令仍在）；
 *   ③ 同一个 ctx 里 apply 后**再**给 webServer，不能重复注册（重复 = 启动期抛错）；
 *   ④ 诊断文件 `host-status.json` 如实记 pending → mounted。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\host-bridge-test.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/host.js'
import { HOST_BRIDGES, HOST_STATUS_VERSION, hostStatusFile } from '../lib/host-status.js'
import { REVIEW_BRIDGE_ROUTE, REVIEW_ROUTE } from '../lib/review-store.js'
import { HANDOFF_BRIDGE_ROUTE, HANDOFF_CONFIG_ROUTE, HANDOFF_PROJECT_ROUTE } from '../lib/handoff-config.js'
import { MODEL_SETTINGS_ROUTE } from '../lib/host.js'

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

const EXPECTED_ROUTES = [REVIEW_ROUTE, REVIEW_BRIDGE_ROUTE, MODEL_SETTINGS_ROUTE,
  HANDOFF_CONFIG_ROUTE, HANDOFF_PROJECT_ROUTE, HANDOFF_BRIDGE_ROUTE]

const home = await mkdtemp(join(tmpdir(), 'dsh-limbs-bridge-'))

/** 一套假 Host ctx。`inject` 可关掉，用来对照「老 cordis」那条分支。 */
function makeCtx({ withInject = true, webServer = null } = {}) {
  const routes = []
  const injected = []
  const pending = []
  const registered = { tools: [], commands: [] }
  // ⚠️ 传进来的 webServer 必须**原样**交给人家的 `register`，不能再包一层
  // 自己的登记函数 —— 那会让「外部 server 收到哪些路由」永远为空，
  // 测试就变成自己骗自己（第一版本文件正是这么假绿的）。
  const server = webServer === null ? null : webServer
  const ctx = {
    sessions: { get: () => undefined },
    get(name) {
      if (name === 'webServer') return server ?? undefined
      if (name === 'dshHomePath') return (...parts) => join(home, ...parts)
      return undefined
    },
    tools: { register: (definition) => { registered.tools.push(definition.name); return () => {} } },
    commands: { register: (definition) => { registered.commands.push(definition.name); return () => {} } },
    on: (event, listener) => {
      if (event === 'webserver/index-inject') injected.push(listener)
      return () => {}
    },
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    routes, injected, registered,
  }
  if (withInject) {
    // 真实 cordis 的 ctx.inject(…, cb)：**服务没出现就先攒着**，出现时以一个新
    // scope 跑回调。这里只模拟这一个语义（攒 → 到点跑一次）。
    ctx.inject = (names, callback) => {
      pending.push({ names, callback })
      if (names.includes('webServer') && server !== null) {
        pending.pop()
        callback({ ...ctx, webServer: server })
      }
      return () => {}
    }
    /** 测试驱动：把 webServer 现在补上，让攒着的回调跑起来。 */
    ctx.lateWebServer = (lateServer) => {
      const queued = pending.splice(0, pending.length)
      for (const { names, callback } of queued) {
        if (!names.includes('webServer')) continue
        callback({ ...ctx, webServer: lateServer })
      }
    }
  }
  return ctx
}

// ════════════════════════════════════════════════════════════════════
console.log('\n[1] webServer 迟到：apply 时不出现，#165 之后补上')
const lateServer = { register: null }
const lateRoutes = []
lateServer.register = (definition) => {
  if (lateRoutes.includes(definition.path)) throw new Error(`duplicate route ${definition.path}`)
  lateRoutes.push(definition.path)
  return () => {}
}
lateServer.tapIndex = () => () => {}

const lateCtx = makeCtx({ withInject: true })
let lateThrew = false
try { apply(lateCtx) } catch (error) { lateThrew = true; console.log('  apply 抛错:', String(error)) }
check('webServer 缺席时 apply 不抛错', !lateThrew)
check('apply 时确实还没挂上任何路由（复现故障形态）', lateCtx.routes.length === 0,
  lateCtx.routes.join(','))
check('但工具照常注册（插件本体没被拖下水）',
  lateCtx.registered.tools.includes('analyze_conversation_efficiency'),
  lateCtx.registered.tools.join(','))

lateCtx.lateWebServer(lateServer)
check('webServer 出现后回调补跑，六条路由全部注册',
  EXPECTED_ROUTES.every((route) => lateRoutes.includes(route)),
  `got ${lateRoutes.join(',')}`)
check('路由数量正好是预期的六条（没有重复、没有漏）',
  lateRoutes.length === EXPECTED_ROUTES.length, `got ${lateRoutes.length}`)

// ════════════════════════════════════════════════════════════════════
console.log('\n[2] webServer 一开始就在：当场挂上，且不重复')
const earlyRoutes = []
const earlyServer = {
  register: (definition) => {
    if (earlyRoutes.includes(definition.path)) throw new Error(`duplicate route ${definition.path}`)
    earlyRoutes.push(definition.path)
    return () => {}
  },
  tapIndex: () => () => {},
}
const earlyCtx = makeCtx({ withInject: true, webServer: earlyServer })
let earlyThrew = false
try { apply(earlyCtx) } catch (error) { earlyThrew = true; console.log('  apply 抛错:', String(error)) }
check('webServer 已在时 apply 不抛错', !earlyThrew)
check('六条路由当场注册齐',
  EXPECTED_ROUTES.every((route) => earlyRoutes.includes(route)) && earlyRoutes.length === EXPECTED_ROUTES.length,
  `got ${earlyRoutes.join(',')}`)
// index 注入监听：模块三（复盘）与模块八（项目）**各挂一份**，共两份 ——
// 这是既有设计（两份 payload 的全局名不同，见各模块的 BRIDGE_GLOBAL）。
// 这里要守的是「没有因为迟到补跑而变成四份」，以及两份各推自己那一行。
check('index 注入监听是两份（复盘 + 项目各一份，不多不少）',
  earlyCtx.injected.length === 2, String(earlyCtx.injected.length))
{
  const table = []
  for (const listener of earlyCtx.injected) listener(table)
  const names = table.map((row) => row?.name).filter((name) => typeof name === 'string')
  check('两份监听各推一自己的全局名（没有互相顶替）',
    names.includes('__DSH_LIMBS_REVIEW__') && names.includes('__DSH_LIMBS_HANDOFF__'),
    JSON.stringify(names))
}

// 再补一次 webServer：攒着的回调应为空，不能二次注册
earlyCtx.lateWebServer(earlyServer)
check('重复给 webServer 不会二次注册', earlyRoutes.length === EXPECTED_ROUTES.length,
  `got ${earlyRoutes.length}`)

// ════════════════════════════════════════════════════════════════════
console.log('\n[3] webServer 永远缺席：只降级，不抛错、不连累')
const neverCtx = makeCtx({ withInject: true })
let neverThrew = false
try { apply(neverCtx) } catch { neverThrew = true }
check('永远缺席时 apply 仍不抛错', !neverThrew)
check('永远缺席时没有注册任何 /limbs 路由（如实空）', neverCtx.routes.length === 0,
  neverCtx.routes.join(','))
check('永远缺席时系统提示词/交接工具仍在（模块七不依赖 webServer）',
  neverCtx.registered.tools.includes('handoff_lookup'),
  neverCtx.registered.tools.join(','))

// ════════════════════════════════════════════════════════════════════
console.log('\n[4] 老 cordis（没有 ctx.inject）：退回一次性尝试，也要记住结果')
const legacyRoutes = []
const legacyServer = {
  register: (definition) => { legacyRoutes.push(definition.path); return () => {} },
  tapIndex: () => () => {},
}
const legacyCtx = makeCtx({ withInject: false, webServer: legacyServer })
let legacyThrew = false
try { apply(legacyCtx) } catch { legacyThrew = true }
check('没有 ctx.inject 时也不抛错', !legacyThrew)
check('没有 ctx.inject 时靠 ctx.get 照样挂上六条',
  EXPECTED_ROUTES.every((route) => legacyRoutes.includes(route)),
  `got ${legacyRoutes.join(',')}`)

// ════════════════════════════════════════════════════════════════════
console.log('\n[5] 诊断快照如实记录（直接读 recorder，不靠磁盘）')
const { createHostStatusRecorder } = await import('../lib/host-status.js')
const recorder = createHostStatusRecorder(earlyCtx, { file: join(home, 'probe-status.json') })
recorder.setWebServer('active')
recorder.record('review', { status: 'mounted', routes: [REVIEW_ROUTE, REVIEW_BRIDGE_ROUTE] })
recorder.record('modelSettings', { status: 'mounted', routes: [MODEL_SETTINGS_ROUTE] })
recorder.record('handoff', { status: 'mounted', routes: [HANDOFF_CONFIG_ROUTE, HANDOFF_PROJECT_ROUTE, HANDOFF_BRIDGE_ROUTE] })
const snap = recorder.snapshot()
check('版本字段正确', snap.version === HOST_STATUS_VERSION)
check('webServer 记成 active', snap.webServer === 'active', String(snap.webServer))
check('三个桥位都在', HOST_BRIDGES.every((name) => snap.bridges?.[name] !== undefined),
  JSON.stringify(Object.keys(snap.bridges ?? {})))
check('三个桥都记成 mounted',
  HOST_BRIDGES.every((name) => snap.bridges[name]?.status === 'mounted'),
  JSON.stringify(snap.bridges))
check('记下了真实路由名',
  snap.bridges.review.routes.includes(REVIEW_ROUTE)
  && snap.bridges.modelSettings.routes.includes(MODEL_SETTINGS_ROUTE)
  && snap.bridges.handoff.routes.includes(HANDOFF_CONFIG_ROUTE),
  JSON.stringify(snap.bridges))
await recorder.flush()
const probe = await readFile(join(home, 'probe-status.json'), 'utf8').catch(() => '')
check('显式给 file 时真的落盘了', probe.includes('"version"'), probe.slice(0, 120))

// ════════════════════════════════════════════════════════════════════
await rm(home, { recursive: true, force: true })
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
