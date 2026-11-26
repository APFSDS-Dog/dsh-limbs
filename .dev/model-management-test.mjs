/**
 * 模块二 · 档位化交互与模型管理 · 离线测试。
 *
 * 覆盖四层：
 *   1. 档位配置（levels.js）：顺序、最高档开关、旧配置映射；
 *   2. Client 档位逻辑：内置表与单一真源一致、回退禁用档、摘要文案；
 *   3. Host 保存接口：账号分桶、最新时间优先、冲突、令牌、迁移；
 *   4. 页面与交互：注册面、无滑动条、二次确认。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\model-management-test.mjs
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SETTINGS,
  REASONING_LEVELS,
  buildLevels,
  mapLegacyReasoning,
  migrateSettings,
  normalizeSettings,
} from '../lib/model-management/levels.js'
import { createModelSettingsBridge, serveModelSettings } from '../lib/host.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

// ── 微型 React（支持重渲染后的 state/ref 保持）──────────────────────────
const stateStore = new WeakMap()
const refStore = new WeakMap()
let current = null

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props)
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}
function begin(component) {
  let states = stateStore.get(component)
  if (states === undefined) { states = []; stateStore.set(component, states) }
  let refs = refStore.get(component)
  if (refs === undefined) { refs = []; refStore.set(component, refs) }
  const frame = { states, refs, cursor: 0, refCursor: 0, cleanups: [] }
  const previous = current
  current = frame
  return () => { current = previous }
}
const useState = (initial) => {
  const frame = current
  const slot = frame.cursor++
  if (!(slot in frame.states)) frame.states[slot] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    frame.states[slot] = typeof next === 'function' ? next(frame.states[slot]) : next
  }
  return [frame.states[slot], set]
}
const useEffect = (effect) => {
  const frame = current
  const slot = frame.cursor++
  const cleanup = effect()
  if (typeof cleanup === 'function') frame.cleanups[slot] = cleanup
}
const useRef = (initial) => {
  const frame = current
  const slot = frame.refCursor++
  if (!(slot in frame.refs)) frame.refs[slot] = { current: initial }
  return frame.refs[slot]
}
const useCallback = (fn) => { current.cursor += 1; return fn }
const useMemo = (fn) => { current.cursor += 1; return fn() }
const useSyncExternalStore = (_subscribe, getSnapshot) => { current.cursor += 1; return getSnapshot() }
const Fragment = Symbol('Fragment')

const FakeReact = {
  createElement, Fragment, useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore,
}

function expand(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return out }
  if (typeof node !== 'object') {
    out.push({ host: 'text', text: String(node) })
    return out
  }
  if (typeof node.type === 'function') {
    const end = begin(node.type)
    let produced
    try { produced = node.type(node.props) } finally { end() }
    expand(produced, out)
    return out
  }
  if (node.type === Fragment) { expand(node.props.children, out); return out }
  out.push(node)
  expand(node.props.children, out)
  return out
}
function render(component, props) {
  const nodes = []
  const end = begin(component)
  let tree
  try { tree = component(props) } finally { end() }
  expand(tree, nodes)
  return nodes
}
const byClass = (nodes, className) => nodes.find(
  (node) => String(node.props?.className || '').split(/\s+/).includes(className))
const allByClass = (nodes, className) => nodes.filter(
  (node) => String(node.props?.className || '').split(/\s+/).includes(className))
const textOf = (nodes) => nodes
  .map((node) => (node.host === 'text' ? node.text : (typeof node.props?.children === 'string' ? node.props.children : '')))
  .join(' | ')

// ── 浏览器环境桩 ────────────────────────────────────────────────────────
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}
const infoLogs = []
console.info = (...args) => { infoLogs.push(args.map(String).join(' ')) }
globalThis.window = { setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} }
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' }, configurable: true, writable: true,
})
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set id(value) {}, set textContent(value) {}, remove: () => {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
}

function resetStorage() { storage.clear(); infoLogs.length = 0 }

// ═══════════════════════════════════════════════════════════════════════
log('== 1. 档位配置中心')
// ═══════════════════════════════════════════════════════════════════════
check('推理六档从左到右',
  JSON.stringify(REASONING_LEVELS.map((level) => level.id))
  === JSON.stringify(['off', 'provider-default', 'low', 'medium', 'high', 'max']))
check('服务商默认在轨道上缩写为“默认”',
  REASONING_LEVELS.find((level) => level.id === 'provider-default')?.shortLabel === '默认')
check('服务商默认完整说明是中文',
  REASONING_LEVELS.find((level) => level.id === 'provider-default')?.fullDescription.includes('服务商提供的默认强度'))

const allLevels = buildLevels({ showMax: true, maxSupported: false })
check('最高档展示但被置灰',
  allLevels.reasoning.some((level) => level.id === 'max' && level.disabledReason === '当前服务商不支持最高档'))
const hiddenMax = buildLevels({ showMax: false })
check('showMax=false 时最高档不展示', !hiddenMax.reasoning.some((level) => level.id === 'max'))
const supportedMax = buildLevels({ showMax: true, maxSupported: true })
check('服务商支持时最高档可用',
  supportedMax.reasoning.some((level) => level.id === 'max' && level.disabledReason === undefined))

check('关闭/No 映射到关闭', mapLegacyReasoning('No') === 'off' && mapLegacyReasoning('关闭') === 'off')
check('默认/null 映射到服务商默认',
  mapLegacyReasoning('默认') === 'provider-default' && mapLegacyReasoning(null) === 'provider-default')
check('低/中/高/最高映射正确',
  ['低', '中', '高', 'max'].map((value) => mapLegacyReasoning(value)).join(',') === 'low,medium,high,max')
check('无法识别的推理值返回 null', mapLegacyReasoning('turbo') === null)

const migrated = migrateSettings({ effort: 'high' })
check('旧配置迁移保留字段含义', migrated.settings.reasoning === 'high')
check('迁移记录逐条可审计', migrated.changes.length === 1, JSON.stringify(migrated.changes))
const fallbackMigration = migrateSettings({ effort: 'turbo' })
check('无法映射时回退默认档并标记',
  fallbackMigration.settings.reasoning === DEFAULT_SETTINGS.reasoning
  && fallbackMigration.fellBack === true)

const normalized = normalizeSettings({ reasoning: 'max' }, buildLevels({ maxSupported: false }))
check('当前档失效时回退默认档',
  normalized.settings.reasoning === 'provider-default',
  JSON.stringify(normalized))
check('回退给出中文原因', normalized.changes[0]?.reason.includes('回退可用默认档'))

// ═══════════════════════════════════════════════════════════════════════
log('== 2. Host 保存接口')
// ═══════════════════════════════════════════════════════════════════════
const hostDir = await mkdtemp(join(tmpdir(), 'dsh-limbs-mm-'))
const hostFile = join(hostDir, 'model-settings.json')
const token = 'test-token'
const baseUrl = 'http://127.0.0.1:63632/limbs/model-settings'
function request(method, body, options = {}) {
  return new Request(baseUrl, {
    method,
    headers: {
      'x-limbs-token': options.token === undefined ? token : options.token,
      'content-type': 'application/json',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const hostOptions = { token, file: hostFile, now: () => 1000, accountId: 'account-a' }

const emptyGet = await (await serveModelSettings(request('GET'), hostOptions)).json()
check('无记录时返回默认档', emptyGet.ok === true
  && emptyGet.settings.reasoning === 'provider-default')
check('返回档位配置供前端渲染', Array.isArray(emptyGet.levels.reasoning) && emptyGet.levels.reasoning.length === 6)

const putHigh = await serveModelSettings(request('PUT', {
  settings: { reasoning: 'high', updatedAt: 1000 },
}), hostOptions)
const putHighBody = await putHigh.json()
check('保存成功并返回新版本', putHigh.status === 200 && putHighBody.ok === true && putHighBody.revision === 1)
const afterHigh = await (await serveModelSettings(request('GET'), hostOptions)).json()
check('再次读取拿到已保存档位',
  afterHigh.settings.reasoning === 'high')

const conflict = await serveModelSettings(request('PUT', {
  settings: { reasoning: 'low', updatedAt: 900 },
}), hostOptions)
const conflictBody = await conflict.json()
check('服务端更新时返回 409 冲突', conflict.status === 409 && conflictBody.code === 'conflict')
check('冲突响应携带服务端最新设置', conflictBody.settings.reasoning === 'high')
check('冲突不覆盖较新的服务端值',
  (await (await serveModelSettings(request('GET'), hostOptions)).json()).settings.reasoning === 'high')

const newer = await (await serveModelSettings(request('PUT', {
  settings: { reasoning: 'medium', updatedAt: 2000 },
}), hostOptions)).json()
check('客户端时间更新时最新时间优先', newer.ok === true && newer.settings.reasoning === 'medium')

const accountB = { ...hostOptions, accountId: 'account-b' }
const bGet = await (await serveModelSettings(request('GET'), accountB)).json()
check('账号之间互相隔离', bGet.settings.updatedAt === 0 && bGet.settings.reasoning === 'provider-default')
await serveModelSettings(request('PUT', {
  settings: { reasoning: 'low', updatedAt: 1100 },
}), accountB)

check('错误令牌被拒绝',
  (await serveModelSettings(request('GET', undefined, { token: 'wrong' }), hostOptions)).status === 403)
check('跨站来源被拒绝',
  (await serveModelSettings(request('GET', undefined, { origin: 'http://evil.example' }), hostOptions)).status === 403)
check('非法档位被拒绝',
  (await serveModelSettings(request('PUT', { settings: { reasoning: 'turbo', updatedAt: 1 } }), hostOptions)).status === 400)
check('缺少设置内容被拒绝',
  (await serveModelSettings(request('PUT', {}), hostOptions)).status === 400)

const legacyFile = join(hostDir, 'legacy.json')
await mkdir(dirname(legacyFile), { recursive: true })
await writeFile(legacyFile, JSON.stringify({
  accounts: { 'account-a': { effort: 'low', updatedAt: 5 } },
  revision: 2,
}), 'utf8')
const legacyGet = await (await serveModelSettings(request('GET'), { ...hostOptions, file: legacyFile })).json()
check('磁盘上的旧格式读取时迁移', legacyGet.settings.reasoning === 'low')
const fileOnDisk = JSON.parse(await readFile(hostFile, 'utf8'))
check('保存按账号分桶并写盘', fileOnDisk.accounts['account-a'].reasoning === 'medium'
  && fileOnDisk.accounts['account-b'] !== undefined)

const routes = []
const taps = []
const fakeWebServer = {
  register: (route) => { routes.push(route); return () => {} },
  tapIndex: (tap) => { taps.push(tap); return () => {} },
}
const bridgeCtx = {
  get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
  effect: (fn) => { fn(); return () => {} },
}
const bridge = createModelSettingsBridge(bridgeCtx, {
  token: 'bridge-token', file: join(hostDir, 'bridge.json'), accountId: 'account-a',
})
check('Host 保存接口挂到约定路由', bridge !== undefined && routes[0]?.path === '/limbs/model-settings')
check('Host 保存接口只注册一条路由', routes.length === 1)
const injected = taps[0]('<html><head></head></html>')
check('页面注入保存令牌', typeof injected === 'string' && injected.includes('bridge-token')
  && injected.includes('__DSH_LIMBS_BRIDGE__'))
check('没有 webServer 时静默降级',
  createModelSettingsBridge({ get: () => undefined, effect: () => {} }) === undefined)

const http = await import('node:http')
const server = http.createServer((req, res) => { void routes[0].handler(req, res) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const liveUrl = `http://127.0.0.1:${String(port)}/limbs/model-settings`
const liveGet = await fetch(liveUrl, { headers: { 'x-limbs-token': 'bridge-token' } })
const liveGetBody = await liveGet.json()
check('Node 路由适配器可读', liveGet.status === 200 && liveGetBody.settings.reasoning === 'provider-default')
const livePut = await fetch(liveUrl, {
  method: 'PUT',
  headers: { 'x-limbs-token': 'bridge-token', 'content-type': 'application/json' },
  body: JSON.stringify({ settings: { reasoning: 'low', updatedAt: 1200 } }),
})
const livePutBody = await livePut.json()
check('Node 路由适配器可写', livePut.status === 200 && livePutBody.settings.reasoning === 'low')
const liveForbidden = await fetch(liveUrl)
check('Node 路由适配器校验令牌', liveForbidden.status === 403)
await new Promise((resolve) => server.close(resolve))
await rm(hostDir, { recursive: true, force: true })

// ═══════════════════════════════════════════════════════════════════════
log('== 3. Client 逻辑与仓库')
// ═══════════════════════════════════════════════════════════════════════
resetStorage()
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let captured = null
window.__ModuleLoader__ = { load: (spec) => { captured = spec } }
new Function(source)()

check('内容区宽度约束为 400–640px',
  source.includes('min-width:400px') && source.includes('max-width:640px'))
check('尊重 prefers-reduced-motion', source.includes('@media (prefers-reduced-motion: reduce)'))

const registry = new Map()
const record = (bucket, entry) => {
  if (!registry.has(bucket)) registry.set(bucket, [])
  registry.get(bucket).push(entry)
}
const slots = {
  inject: (_key, callback) => { callback(); return () => {} },
  register: (options, component) => { record(options.name, { options, component }); return () => {} },
}
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  effect: (fn) => { fn(); return () => {} },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})
plugin.apply(ctx)

const settingsEntries = registry.get('settings.section') || []
const modelEntry = settingsEntries.find((entry) => entry.options.id === 'limbs-model')
check('模块二注册为独立设置分区', modelEntry !== undefined)
check('模块二使用自己的 id（不顶掉官方模型页）', modelEntry?.options.id === 'limbs-model')
check('模块二排在官方模型页之后', modelEntry?.options.order === 11)
check('模块二菜单名为中文“模型管理”', modelEntry?.options.label?.() === '模型管理')
check('模块三设置分区仍保留', settingsEntries.some((entry) => entry.options.id === 'limbs'))
check('模块一模型座位未被破坏',
  (registry.get('conversation.input.model') || []).some((entry) => entry.options.priority === -1))

const test = plugin.__test
const levelsSource = { reasoning: REASONING_LEVELS, defaults: DEFAULT_SETTINGS }
const fallbackComparable = {
  reasoning: test.MM_FALLBACK_LEVELS.reasoning,
  defaults: test.MM_FALLBACK_LEVELS.defaults,
}
check('Client 内置档位表与单一真源一致',
  JSON.stringify(fallbackComparable) === JSON.stringify(levelsSource),
  JSON.stringify(fallbackComparable))

const built = test.mmBuildLevels(null, { showMax: true, maxSupported: false })
check('内置档位生成最高档禁用原因',
  built.reasoning.find((level) => level.id === 'max')?.disabledReason === '当前服务商不支持最高档')
check('关闭档顶部摘要显示已关闭',
  test.mmReasoningSummary({ reasoning: 'off' }, built).text === '已关闭')
check('服务商默认顶部摘要与完整说明',
  test.mmReasoningSummary({ reasoning: 'provider-default' }, built).detail
  === '服务商默认：使用服务商提供的默认强度')

resetStorage()
localStorage.setItem('dsh-limbs:settings', JSON.stringify({ effort: 'high' }))
const migratedStore = test.createModelSettingsStore(ctx)
check('Client 启动时迁移旧配置',
  migratedStore.getSnapshot().settings.reasoning === 'high')
check('迁移写入审计日志',
  JSON.parse(localStorage.getItem('dsh-limbs:model-migration-log') || '[]').length === 1)

resetStorage()
const localStore = test.createModelSettingsStore(ctx, {
  now: () => 100,
  modelName: 'DeepSeek V4.1 Flash',
})
await localStore.change({ reasoning: 'off' })
check('本地保存即时更新',
  localStore.getSnapshot().settings.reasoning === 'off'
  && localStore.getSnapshot().status === 'ready')
check('本地保存写入缓存',
  JSON.parse(localStorage.getItem('dsh-limbs:model-settings:v2') || '{}').reasoning === 'off')
const savedDefaults = localStore.getSnapshot().settings
await localStore.restoreDefaults()
check('恢复默认只改推理档位字段',
  localStore.getSnapshot().settings.reasoning === 'provider-default'
  && savedDefaults.reasoning !== localStore.getSnapshot().settings.reasoning)
check('恢复默认不改当前模型名', localStore.getSnapshot().modelName === 'DeepSeek V4.1 Flash')

resetStorage()
const failingStore = test.createModelSettingsStore(ctx, {
  now: () => 200,
  bridge: { path: '/limbs/model-settings', token: 't' },
  fetchImpl: async (_url, init) => {
    if (init.method === 'GET') {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          revision: 1,
          settings: { reasoning: 'provider-default', updatedAt: 10 },
          levels: { reasoning: REASONING_LEVELS, defaults: DEFAULT_SETTINGS },
        }),
      }
    }
    throw new Error('offline')
  },
})
await failingStore.start()
await failingStore.change({ reasoning: 'high' })
check('保存失败回滚到旧档位',
  failingStore.getSnapshot().settings.reasoning === 'provider-default'
  && failingStore.getSnapshot().status === 'error')
check('保存失败给出中文提示',
  failingStore.getSnapshot().toast?.text === '保存失败，已恢复原设置')

resetStorage()
const conflictStore = test.createModelSettingsStore(ctx, {
  now: () => 300,
  maxSupported: true,
  bridge: { path: '/limbs/model-settings', token: 't' },
  fetchImpl: async () => ({
    status: 409,
    json: async () => ({
      code: 'conflict',
      revision: 9,
      settings: { reasoning: 'max', updatedAt: 900 },
      levels: { reasoning: REASONING_LEVELS, defaults: DEFAULT_SETTINGS },
    }),
  }),
})
await conflictStore.start()
await conflictStore.change({ reasoning: 'low' })
check('多端冲突采用服务端较新时间',
  conflictStore.getSnapshot().settings.reasoning === 'max'
  && conflictStore.getSnapshot().settings.updatedAt === 900)
check('多端冲突提示中文文案',
  conflictStore.getSnapshot().toast?.text === '设置已在其他设备更新，已同步最新设置')

resetStorage()
let pushed = null
const upgradeStore = test.createModelSettingsStore(ctx, {
  now: () => 500,
  localSettings: { reasoning: 'high' },
  bridge: { path: '/limbs/model-settings', token: 't' },
  fetchImpl: async (_url, init) => {
    const body = init.body === undefined ? null : JSON.parse(init.body)
    if (init.method === 'GET') {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          revision: 0,
          settings: { reasoning: 'provider-default', updatedAt: 0 },
          levels: { reasoning: REASONING_LEVELS, defaults: DEFAULT_SETTINGS },
        }),
      }
    }
    pushed = body
    return {
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        revision: 1,
        settings: body.settings,
        levels: { reasoning: REASONING_LEVELS, defaults: DEFAULT_SETTINGS },
      }),
    }
  },
})
await upgradeStore.start()
check('首次升级时本机迁移结果推送到 Host，而不是被默认值覆盖',
  pushed?.settings?.reasoning === 'high' && upgradeStore.getSnapshot().settings.reasoning === 'high',
  JSON.stringify(pushed?.settings))

resetStorage()
const invalidStore = test.createModelSettingsStore(ctx, {
  maxSupported: false,
  localSettings: { reasoning: 'max', updatedAt: 1 },
})
check('当前选中档失效时自动回退默认档',
  invalidStore.getSnapshot().settings.reasoning === 'provider-default')
check('自动回退给出 Toast 提示',
  invalidStore.getSnapshot().toast?.text === '当前档位不可用，已回退到默认档')

// ═══════════════════════════════════════════════════════════════════════
log('== 4. 页面与交互')
// ═══════════════════════════════════════════════════════════════════════
resetStorage()
localStorage.setItem('dsh-limbs:last-model', JSON.stringify({
  name: 'DeepSeek V4.1 Flash', maxSupported: false,
}))
const page = render(modelEntry.component, {})
const sliders = page.filter((node) => node.props?.role === 'slider')
check('页面不再渲染任何横向滑动条', sliders.length === 0, String(sliders.length))
check('页面上没有残留的刻度', allByClass(page, 'mm-tickLabel').length === 0)
check('页面上没有上下文摘要', !textOf(page).includes('上下文'))
check('页面显示当前模型名', textOf(page).includes('DeepSeek V4.1 Flash'))
check('顶部有推理摘要胶囊', textOf(page).includes('推理 · 服务商默认'))

// 二次确认：恢复默认只改推理档位
resetStorage()
const confirmPage = render(modelEntry.component, {})
const resetButton = byClass(confirmPage, 'mm-reset')
check('底部有恢复默认按钮', resetButton?.props?.children === '恢复默认')
resetButton.props.onClick()
const dialogPage = render(modelEntry.component, {})
const dialog = dialogPage.find((node) => node.props?.role === 'alertdialog')
check('恢复默认需要二次确认', dialog !== undefined)
check('确认框说明只影响推理档位',
  textOf(dialogPage).includes('只会恢复“推理挡位”，当前模型不会改变'))
const confirmButton = byClass(dialogPage, 'mm-dialogConfirm')
check('确认按钮文案为“确认恢复”', confirmButton?.props?.children === '确认恢复')
confirmButton.props.onClick()
const afterReset = render(modelEntry.component, {})
check('确认后弹窗关闭', afterReset.find((node) => node.props?.role === 'alertdialog') === undefined)

// 中文残留检查
const mmTexts = Object.values(test.MM).filter((value) => typeof value === 'string')
check('模块二文案全部含中文', mmTexts.every((text) => /[\u4e00-\u9fff]/.test(text)))
check('模块二文案无英文句子', mmTexts.every((text) => !/[A-Za-z]{3,}/.test(text)),
  JSON.stringify(mmTexts.filter((text) => /[A-Za-z]{3,}/.test(text))))

log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
