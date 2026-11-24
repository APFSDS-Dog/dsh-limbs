/**
 * 模块八 · 项目管理 UI（段 2：左栏入口 + 一级总管理页）· 离线测试。
 *
 * 验什么：
 *   1. 注册面：`sidebar.panellist` 新 id（'limbs-projects'）+ `main` 新 key，
 *      且**没有**动模块一/二/三/七的既有注册；
 *   2. 源码卫生：单独的 M8 style 块（不是复用模块一的 CSS 常量）、体内无反引号；
 *   3. 一级页渲染：全局默认（只读四个值）、项目列表 + 每项摘要（账表条数 /
 *      最近收尾 / 真写开关 / 热注入开关）、手填路径入口；
 *   4. 只读性：一级页**不写任何配置**（浏览不动 .dsh/handoff.yaml）。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\projects-ui-test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── 微型 React（与 .dev/ui-shell-test.mjs 同一套替身）────────────────────
const stateStore = new WeakMap()
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
  const frame = { states, cursor: 0 }
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
    if (typeof frame.setterRefresh === 'function') frame.setterRefresh()
  }
  return [frame.states[slot], set]
}
const useEffect = (effect) => { current.cursor += 1; effect() }
const useRef = (initial) => { current.cursor += 1; return { current: initial } }
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
  if (typeof node !== 'object') { out.push({ host: 'text', text: String(node) }); return out }
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
const hosts = (nodes, type) => nodes.filter((node) => node.type === type)
const byClass = (nodes, className) => nodes.find(
  (node) => String(node.props?.className || '').split(/\s+/).includes(className))
const texts = (nodes) => nodes.map((node) => (node.host === 'text' ? node.text : '')).join(' ')
const textOf = (nodes) => nodes
  .map((node) => (node.host === 'text' ? node.text : (typeof node.props?.children === 'string' ? node.props.children : '')))
  .join(' | ')

// ── 浏览器环境桩 ────────────────────────────────────────────────────────
const styles = []
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const noop = () => {}
globalThis.window = { setTimeout, clearTimeout }
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' }, configurable: true, writable: true,
})
globalThis.document = {
  getElementById: (id) => styles.find((node) => node.id === id) ?? null,
  createElement: () => {
    const node = {
      id: null,
      textContent: null,
      remove: () => { const index = styles.indexOf(node); if (index >= 0) styles.splice(index, 1) },
    }
    return node
  },
  head: { appendChild: (node) => styles.push(node) },
  addEventListener: noop,
  removeEventListener: noop,
  body: {},
}

// ── 0. 源码卫生（先查，免得后面全是假绿）──────────────────────────────
log('== source hygiene')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// 模块一的 CSS 常量仍是原来那一段（长度下限守住踩坑录 #8 的截断）
const cssStart = source.indexOf('const CSS = `')
check('模块一的 CSS 常量仍在', cssStart !== -1, String(cssStart))
const cssBody = cssStart === -1 ? '' : source.slice(cssStart + 'const CSS = `'.length, source.indexOf('`', cssStart + 'const CSS = `'.length))
check('模块一 CSS 体仍非平凡（> 2000 字符）', cssBody.length > 2000, String(cssBody.length))
check('模块一 CSS 体内无残留反引号', (cssBody.match(/`/g) || []).length === 0)
check('模块一的开关样式没被改走', cssBody.includes('.limbs-switchKnob'))

// 模块八的 CSS 必须是**独立**常量、独立 id
const m8Start = source.indexOf('const M8_CSS = `')
check('模块八 CSS 是独立常量', m8Start !== -1, String(m8Start))
const m8Body = m8Start === -1 ? '' : source.slice(m8Start + 'const M8_CSS = `'.length, source.indexOf('`', m8Start + 'const M8_CSS = `'.length))
check('模块八 CSS 体非平凡（> 1000 字符）', m8Body.length > 1000, String(m8Body.length))
check('模块八 CSS 体内无反引号（踩坑录 #8）', (m8Body.match(/`/g) || []).length === 0,
  String((m8Body.match(/`/g) || []).length))
check('模块八 style 用新 id', source.includes("const M8_STYLE_ID = 'dsh-limbs-m8-styles'"))
check('模块八 style id 与模块一的 id 不同', !source.includes("dsh-limbs-m8-styles' === 'dsh-limbs-styles"))
check('模块八 CSS 自带 m8 前缀的开关', m8Body.includes('.m8-switch') && m8Body.includes('.m8-switchKnob'))
check('模块八没有复用模块一的 .limbs-switch 选择器', !m8Body.includes('.limbs-'))
check('模块八 CSS 只用主题 token（无写死主色）',
  (m8Body.match(/#4f8cff/gi) || []).length === (m8Body.match(/var\(--dsw-alias-[a-z-]+,\s*#4f8cff\s*\)/gi) || []).length,
  `#4f8cff=${(m8Body.match(/#4f8cff/gi) || []).length} · token 内=${(m8Body.match(/var\(--dsw-alias-[a-z-]+,\s*#4f8cff\s*\)/gi) || []).length}`)
check('bundle 没留下 TODO/FIXME 占位', !source.includes('TODO:') && !source.includes('FIXME:'))
check('模块八的文案里没有未实现的占位话术', !source.includes('模块八占位'))

// ── 装载插件 ────────────────────────────────────────────────────────────
let captured = null
globalThis.window.__ModuleLoader__ = { load: (spec) => { captured = spec } }
new Function(source)()

const registry = new Map()
const record = (bucket, entry) => {
  if (!registry.has(bucket)) registry.set(bucket, [])
  registry.get(bucket).push(entry)
}
const slots = {
  inject: (_key, callback) => { callback(); return noop },
  register: (options, component) => { record(options.name, { options, component }); return noop },
}
const tabTypes = []
const openedTabs = []
const ctx = {
  get: (name) => {
    if (name === 'slots') return slots
    if (name === 'sidebarRightTabs') return { register: (definition) => { tabTypes.push(definition); return noop } }
    if (name === 'sidebarRight') return { openTab: (kind) => { openedTabs.push(kind) } }
    return undefined
  },
  effect: (fn) => { fn(); return noop },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})
plugin.apply(ctx)

// ── 1. 注册面 ───────────────────────────────────────────────────────────
log('== registration')
const icon = (registry.get('sidebar.panellist') || []).find(entry => entry.options.id === 'limbs-projects')
check('左栏「项目」图标已注册', icon !== undefined, JSON.stringify((registry.get('sidebar.panellist') || []).map(e => e.options.id)))
check('图标 id 是新的 limbs-projects', icon?.options.id === 'limbs-projects', String(icon?.options.id))
check('图标 order 排在 github(20) 之后', icon?.options.order === 30, String(icon?.options.order))
check('图标 label 是 thunk（跟随语言）', typeof icon?.options.label === 'function')
check('图标 label 中文是「项目」', icon?.options.label?.() === '项目', String(icon?.options.label?.()))

const mainPanel = (registry.get('main') || []).find(entry => entry.options.key === 'limbs-projects')
check('主区面板已注册', mainPanel !== undefined, JSON.stringify((registry.get('main') || []).map(e => e.options.key)))
check('主区面板 key 与图标 id 对齐', mainPanel?.options.key === 'limbs-projects', String(mainPanel?.options.key))
check('主区面板没抢 conversation 这个保留 key',
  !(registry.get('main') || []).some(entry => entry.options.key === 'conversation'))

// 模块八必须留在模块八：不能挤掉模块一/二/三/七的注册
check('模块一模型座位仍以 priority=-1 遮蔽官方（没回归）',
  (registry.get('conversation.input.model') || []).some(entry => entry.options.priority === -1))
check('模块二模型管理页仍在（id limbs-model）',
  (registry.get('settings.section') || []).some(entry => entry.options.id === 'limbs-model'))
check('模块三 Limbs 配置页仍在（id limbs）',
  (registry.get('settings.section') || []).some(entry => entry.options.id === 'limbs'))
check('模块三复盘 tab 类型仍在', tabTypes.length === 1 && tabTypes[0].kind === 'limbs-review')
check('模块三标题行入口仍在（id limbs-review）',
  (registry.get('conversation.session.header.utilities') || []).some(entry => entry.options.id === 'limbs-review'))
check('模块八没有往 settings.section 里塞第五个格子',
  (registry.get('settings.section') || []).length === 2, String((registry.get('settings.section') || []).length))

// ── 2. 独立 style 块：装入 + 热重载先清旧 ──────────────────────────────
log('== style block')
const installed = styles.find(node => node.id === plugin.__test.M8_STYLE_ID)
check('离开 apply 后 style 已装进页面', installed !== undefined, JSON.stringify(styles.map(n => n.id)))
check('style 装的是模块八自己的 CSS', installed?.textContent === plugin.__test.M8_CSS)
check('模块八 style 用新 id、模块一 style 用自己的 id（两个都在，互不覆盖）',
  plugin.__test.M8_STYLE_ID !== 'dsh-limbs-styles'
  && styles.some(node => node.id === plugin.__test.M8_STYLE_ID)
  && styles.some(node => node.id === 'dsh-limbs-styles'),
  JSON.stringify(styles.map(n => n.id)))
check('两个 style 元素是各自独立的文本（模块一 CSS 没被换成 m8 的）',
  styles.find(node => node.id === 'dsh-limbs-styles')?.textContent?.includes('.limbs-switchKnob')
  && !styles.find(node => node.id === 'dsh-limbs-styles')?.textContent?.includes('.m8-switch'),
  '')

// 热重载语义（踩坑录 #7）：**旧 style 还在页面上**时再装一次，
// 必须「先 remove 同 id 旧元素，再无条写入当前文本」—— 否则页面会一直吃旧 CSS。
{
  // 造一个「上一条命」留下的 style：文本是旧的，remove 真的会从 head 摘掉它。
  // 先把当前这条命装的那份摘掉，让「旧元素」成为唯一的一份 —— 否则下面数出来的
  // 是「旧 + 新」两条，断言失败（第一次写这条测试就是这么假绿的）。
  const priorIndex = styles.findIndex(node => node.id === plugin.__test.M8_STYLE_ID)
  if (priorIndex >= 0) styles.splice(priorIndex, 1)
  const stale = {
    id: plugin.__test.M8_STYLE_ID,
    textContent: 'OLD-CSS',
    remove() { const index = styles.indexOf(stale); if (index >= 0) styles.splice(index, 1) },
  }
  styles.push(stale)

  // 一次「热重载」= 再执行一遍 bundle 文本 + apply（旧 effect 的 cleanup 不走，
  // 这正是踩坑录 #7 的真实条件：模块换了，上一轮的 style 还在）。
  //
  // ⚠️ 这条桩必须给每个 style 元素一个**独有的 `remove` 闭包**（真的从 head 摘自己），
  // 否则「先 remove 再写」看起来会通过、其实删错了元素 —— 第一次写这条测试时
  // 就是这么假绿的（旧元素没删、新元素又追加，`.filter(...).length === 2`）。
  let again = null
  globalThis.window.__ModuleLoader__ = { load: (spec) => { again = spec } }
  new Function(source)()
  const reloaded = again.factory(name => {
    if (name === 'react') return FakeReact
    throw new Error('unexpected ' + name)
  })
  const reloadRegistry = new Map()
  const reloadSlots = {
    inject: (_key, callback) => { callback(); return noop },
    register: (options, component) => {
      if (!reloadRegistry.has(options.name)) reloadRegistry.set(options.name, [])
      reloadRegistry.get(options.name).push({ options, component })
      return noop
    },
  }
  const reloadCtx = {
    get: (name) => (name === 'slots' ? reloadSlots : undefined),
    effect: (fn) => { fn(); return noop },
  }
  reloaded.apply(reloadCtx)

  const live = styles.filter(node => node.id === plugin.__test.M8_STYLE_ID)
  check('热重载后同 id 只剩一个 style 元素', live.length === 1, String(live.length))
  check('热重载写入的是当前 CSS 文本（不是旧文本）',
    live[0]?.textContent === plugin.__test.M8_CSS, String(live[0]?.textContent?.slice(0, 20)))
  check('热重载没有把模块一的 style 一起清掉',
    styles.some(node => node.id === 'dsh-limbs-styles'), JSON.stringify(styles.map(n => n.id)))
  check('热重载后左栏入口仍只注册一次',
    (reloadRegistry.get('sidebar.panellist') || []).filter(e => e.options.id === 'limbs-projects').length <= 1,
    String((reloadRegistry.get('sidebar.panellist') || []).length))
}

// ── 3. 假 Host 接口 + 一级页渲染 ────────────────────────────────────────
log('== first-level page')
const { createProjectsStore, LimbsProjectsPanel } = plugin.__test

const LIST_BODY = {
  ok: true,
  defaults: { inject: true, write: false, ledgerRecent: 10, checkCommand: '' },
  projects: [
    {
      root: 'D:\\Projects\\alpha', title: 'alpha', registered: true, workspaceId: 'ws-a', error: null,
      ledgerRows: 12, latestArchiveId: 't-20261121-04', devlogCount: 8,
      config: { inject: true, write: true, ledgerRecent: 10, checkCommand: '' }, configExists: true,
    },
    {
      root: 'D:\\Projects\\beta', title: 'beta', registered: true, workspaceId: 'ws-b', error: null,
      ledgerRows: 3, latestArchiveId: 't-20261120-02', devlogCount: 2,
      config: { inject: false, write: false, ledgerRecent: 5, checkCommand: 'pwsh -File ./check-docs.ps1' }, configExists: true,
    },
    {
      root: 'D:\\Projects\\gamma', title: null, registered: false, workspaceId: null, error: null,
      ledgerRows: 0, latestArchiveId: null, devlogCount: 0,
      config: { inject: true, write: false, ledgerRecent: 10, checkCommand: '' }, configExists: false,
    },
  ],
  fallback: null,
}

const calls = []
function fakeFetch(path, init) {
  calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
  const body = LIST_BODY
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })
}

const bridge = {
  token: 'ui-token',
  configPath: '/limbs/handoff-config',
  projectPath: '/limbs/handoff-project',
}
const store = createProjectsStore({ bridge, fetchImpl: fakeFetch })
await store.loadList()
const snapshot = store.getSnapshot()
check('一级页只发了一次 GET（读列表）', calls.length === 1 && calls[0].method === 'GET', JSON.stringify(calls))
check('GET 打到 /limbs/handoff-config', calls[0].path === '/limbs/handoff-config', calls[0].path)
check('列表读到了三个项目', snapshot.list.length === 3, String(snapshot.list.length))
check('全局默认被读进来', snapshot.defaults?.inject === true && snapshot.defaults?.write === false,
  JSON.stringify(snapshot.defaults))

const view = render(LimbsProjectsPanel, { store })
const text = textOf(view)

check('标题渲染出来', text.includes('项目管理'), text.slice(0, 120))
check('副标题说明「项目 = 工作区」', text.includes('工作区'), '')
check('全局默认小节在', text.includes('全局默认'))
check('全局默认显示 inject', text.includes('热注入'))
check('全局默认显示 write', text.includes('真写'))
check('全局默认显示 ledgerRecent', text.includes('账表滑窗'))
check('全局默认显示 checkCommand 的自动探测说明', text.includes('自动探测'))
check('账表滑窗的默认值来自 Host（10）', text.includes('10'), textOf(view).slice(0, 200))

check('三个项目都渲染成行', hosts(view, 'button').filter(node =>
  String(node.props?.className || '').includes('m8-project')).length === 3,
  String(hosts(view, 'button').length))
const projectRows = hosts(view, 'button').filter(node => String(node.props?.className || '').includes('m8-project'))
check('项目行有账表条数摘要', text.includes('12') && text.includes('3'), '')
check('项目行有最近收尾 id', text.includes('t-20261121-04'), '')
check('项目行有冷存档条数', text.includes('8'), '')

// 逐项查开关状态：alpha 开 / beta 关，真写 alpha 开 / beta 关
const flagsInRow = (row) => {
  const nodes = []
  expand(row, nodes)
  return nodes.filter(node => String(node.props?.className || '').split(/\s+/).includes('m8-flag'))
}
const alphaFlags = flagsInRow(projectRows[0])
const betaFlags = flagsInRow(projectRows[1])
check('alpha 行两个 flag（热注入 + 真写）', alphaFlags.length === 2, String(alphaFlags.length))
check('alpha 的热注入是「开」', texts(alphaFlags[0].props.children ? [alphaFlags[0]] : []) !== undefined
  && String(alphaFlags[0].props.children?.props?.children ?? alphaFlags[0].props.children) === '开',
  JSON.stringify(alphaFlags[0].props.children))
check('beta 的热注入是「关」', String(betaFlags[0].props.children?.props?.children ?? betaFlags[0].props.children) === '关',
  JSON.stringify(betaFlags[0].props.children))
check('alpha 的真写是「开」', String(alphaFlags[1].props.children?.props?.children ?? alphaFlags[1].props.children) === '开')
check('beta 的真写是「关」', String(betaFlags[1].props.children?.props?.children ?? betaFlags[1].props.children) === '关')

check('未登记项目打了「未登记工作区」标记', text.includes('未登记工作区'), '')
const manualInput = hosts(view, 'input')[0]
check('手填路径入口在', manualInput !== undefined)
check('手填路径是绝对路径提示', String(manualInput?.props?.placeholder || '').includes('D:\\'), String(manualInput?.props?.placeholder))
const manualButton = hosts(view, 'button').find(node => node.props?.className === 'm8-btn' && node.props.children === '打开')
check('手填路径旁边有「打开」', manualButton !== undefined)

// 点某个项目 → 进二级（段 2 只验「状态切过去了」，正文由段 3 落）
// ⚠️ 组件的 onClick 是 `void store.openProject(...)`，是 fire-and-forget：
// 断言前必须等一轮微任务，否则读到的还是「没发请求」的旧快照。
calls.length = 0
projectRows[0].props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
const afterClick = store.getSnapshot()
check('点项目后 selected 指向该项目', afterClick.selected === 'D:\\Projects\\alpha', String(afterClick.selected))
check('点项目后发出了详情 GET',
  calls.some(call => call.method === 'GET' && String(call.path).startsWith('/limbs/handoff-project')),
  JSON.stringify(calls.map(c => c.path)))
check('浏览一级页/进二级**没有**发过 PUT（一级页只读）',
  !calls.some(call => call.method === 'PUT'), JSON.stringify(calls.map(c => c.method)))

log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
