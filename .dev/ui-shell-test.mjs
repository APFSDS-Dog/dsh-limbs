/**
 * 模块三 · UI 壳子离线测试（不启动 DSH、不联网、不装 jsdom）。
 *
 * 验证两件事：
 *   1. 注册面：settings.section / sidebarRightTabs / sidebar.right.pane.tab /
 *      sidebar.right.pane.tab.title / conversation.session.header.utilities
 *      都以正确的 id、order、key 出现，且旧的选择器席位没被弄坏。
 *   2. 交互面：设置页控件能改并落盘；「一键复盘」真的会
 *      console.log('触发复盘')，按钮切到运行态再回落到占位提示。
 *
 * 为什么要自带一个微型 React：lib/client.js 在自己的工厂里解构了
 * useState / useEffect / useSyncExternalStore，外部再 patch React 已经晚了。
 * 所以这里提供了一个只实现「createElement + 六个 hook」的替身，
 * 状态按组件函数持久化，于是重渲染能读到上一轮的值。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\ui-shell-test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

// ── 微型 React ──────────────────────────────────────────────────────────
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
  const frame = { states, cursor: 0, cleanups: [] }
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
const useEffect = (effect) => { current.cursor += 1; effect() }
const useRef = (initial) => { current.cursor += 1; return { current: initial } }
const useCallback = (fn) => { current.cursor += 1; return fn }
const useMemo = (fn) => { current.cursor += 1; return fn() }
const useSyncExternalStore = (_subscribe, getSnapshot) => { current.cursor += 1; return getSnapshot() }
const Fragment = Symbol('Fragment')

const FakeReact = {
  createElement,
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
}

/** 把一棵元素树展开成「宿主节点 + 触达的函数组件结果」，函数组件就地求值。 */
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

/** 渲染一个组件，返回扁平节点表（含 onClick 等真实 props）。 */
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
const logs = []
console.log = (...args) => { logs.push(args.join(' ')) }
const noop = () => {}
globalThis.window = { setTimeout, clearTimeout }
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'zh-CN' }, configurable: true, writable: true,
})
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set id(value) {}, set textContent(value) {}, remove: noop }),
  head: { appendChild: noop },
  addEventListener: noop,
  removeEventListener: noop,
  body: {},
}

// ── 0. 源码卫生 ─────────────────────────────────────────────────────────
// `node --check` does NOT catch this: the CSS is one big template literal, so a
// stray backtick inside a CSS comment silently ends the string early and the
// bundle throws at parse time instead. It shipped once; assert it here.
log('== source hygiene')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const cssStart = source.indexOf('const CSS = `')
check('CSS template literal is locatable', cssStart !== -1, String(cssStart))
if (cssStart !== -1) {
  const bodyStart = cssStart + 'const CSS = `'.length
  // The closing backtick is simply the NEXT one: if a stray backtick exists in
  // a CSS comment, this slice ends too early and the "non-trivial" length and
  // the selector probes below fail, which is exactly the regression to catch.
  const bodyEnd = source.indexOf('`', bodyStart)
  const cssBody = source.slice(bodyStart, bodyEnd)
  check('CSS body is non-trivial (a stray backtick truncates it)', cssBody.length > 2000, String(cssBody.length))
  const strayBackticks = (cssBody.match(/`/g) || []).length
  check('no backtick inside the CSS template literal', strayBackticks === 0, String(strayBackticks))
  check('settings CSS present', cssBody.includes('.limbs-switchKnob') && cssBody.includes('.limbs-select'))
  check('panel CSS present', cssBody.includes('.limbs-run') && cssBody.includes('.limbs-md'))
}
check('bundle has no obvious unresolved placeholder', !source.includes('TODO:') && !source.includes('FIXME:'))

// ── 装载插件 ────────────────────────────────────────────────────────────
let captured = null
window.__ModuleLoader__ = { load: (spec) => { captured = spec } }
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
// NOTE: `console.log` stays patched for the whole run — the review button's
// placeholder really calls it, and the point is to observe that call.
log('== registration')

const settings = (registry.get('settings.section') || [])[0]
check('settings.section registered', settings !== undefined)
check('settings uses its own cell id', settings?.options.id === 'limbs', JSON.stringify(settings?.options))
check('settings order sits between plugins and agent-presets', settings?.options.order === 18)
check('settings label is a thunk (follows locale)', typeof settings?.options.label === 'function')
check('settings label text', settings?.options.label?.() === 'Limbs 配置', String(settings?.options.label?.()))

check('exactly one tab type registered', tabTypes.length === 1, JSON.stringify(tabTypes))
check('tab type is extension band', tabTypes[0]?.priority === 'extension')
check('tab type is a page type (no patterns)', tabTypes[0]?.patterns === undefined)
check('tab type id', tabTypes[0]?.id === 'dsh-limbs')
check('tab type kind', tabTypes[0]?.kind === 'limbs-review')
check('tab type carries one guide entry', Array.isArray(tabTypes[0]?.guide) && tabTypes[0].guide.length === 1)
check('guide entry has a description thunk', typeof tabTypes[0]?.guide?.[0]?.description === 'function')

const body = (registry.get('sidebar.right.pane.tab') || [])[0]
const title = (registry.get('sidebar.right.pane.tab.title') || [])[0]
check('pane body keyed by the tab id', body?.options.key === 'dsh-limbs')
check('pane title keyed by the tab id', title?.options.key === 'dsh-limbs')

const headerEntry = (registry.get('conversation.session.header.utilities') || [])[0]
check('header entry registered', headerEntry !== undefined)
check('header entry id', headerEntry?.options.id === 'limbs-review')
check('header entry order between schedule and unlag', headerEntry?.options.order === 28)
check('model seat still shadows the stock one (no regression)',
  (registry.get('conversation.input.model') || []).some((entry) => entry.options.priority === -1))

// ── 2. 设置页 ───────────────────────────────────────────────────────────
log('== settings section')
const settingsView = render(settings.component, {})
const selects = hosts(settingsView, 'select')
const switchNode = settingsView.find((node) => node.props?.role === 'switch')
check('two dropdowns', selects.length === 2, String(selects.length))
const contextOptions = (selects[0]?.props.children || []).map((option) => option.props.children)
check('context choices are the agreed placeholders',
  JSON.stringify(contextOptions) === JSON.stringify(['128K', '256K', '512K', '1M']),
  JSON.stringify(contextOptions))
const effortOptions = (selects[1]?.props.children || []).map((option) => option.props.children)
check('effort choices localized', JSON.stringify(effortOptions) === JSON.stringify(['低', '中', '高']),
  JSON.stringify(effortOptions))
check('switch exposes aria-checked', switchNode?.props?.['aria-checked'] === 'true',
  String(switchNode?.props?.['aria-checked']))
check('switch is a native button', switchNode?.type === 'button')
check('placeholder notice is visible', textOf(settingsView).includes('当前为界面占位'),
  textOf(settingsView).slice(0, 120))

selects[0].props.onChange({ target: { value: '512K' } })
const stored = () => JSON.parse(storage.get('dsh-limbs:settings') || '{}')
check('context persisted to localStorage', stored().context === '512K', storage.get('dsh-limbs:settings'))
switchNode.props.onClick()
check('switch toggles off and persists', stored().warn === false, storage.get('dsh-limbs:settings'))

const settingsAgain = render(settings.component, {})
const switchAgain = settingsAgain.find((node) => node.props?.role === 'switch')
check('re-render reflects the stored value', switchAgain?.props?.['aria-checked'] === 'false',
  String(switchAgain?.props?.['aria-checked']))
check('re-render keeps the stored dropdown value',
  hosts(settingsAgain, 'select')[0]?.props.value === '512K',
  String(hosts(settingsAgain, 'select')[0]?.props.value))

// ── 3. 复盘面板 ─────────────────────────────────────────────────────────
log('== review panel')
const panelView = render(body.component, {})
const runButton = byClass(panelView, 'limbs-run')
check('run button exists', runButton !== undefined)
check('run button label is 一键复盘', runButton?.props?.children === '一键复盘', String(runButton?.props?.children))
check('quick model switch is a select', hosts(panelView, 'select').length === 1)
const report = byClass(panelView, 'limbs-md')
check('report renders the mock markdown',
  String(report?.props?.children || '').includes('正在等待复盘数据'),
  String(report?.props?.children || '').slice(0, 60))
check('report contains a markdown table', String(report?.props?.children || '').includes('| --- |'))
check('mock badge present', textOf(panelView).includes('假数据'))

logs.length = 0
runButton.props.onClick()
check("click logs '触发复盘'", logs.includes('触发复盘'), JSON.stringify(logs))

const runningView = render(body.component, {})
const runningButton = byClass(runningView, 'limbs-run')
check('button switches to the running state', runningButton?.props?.children === '正在复盘…',
  String(runningButton?.props?.children))
check('button is disabled while running', runningButton?.props?.disabled === true)

await new Promise((resolve) => setTimeout(resolve, 320))
const settledView = render(body.component, {})
const notice = byClass(settledView, 'limbs-runNotice')
check('placeholder notice appears after settling',
  notice !== undefined && String(notice.props.children).includes('占位触发'),
  JSON.stringify(notice?.props?.children))
const settledButton = byClass(settledView, 'limbs-run')
check('button returns to ready state', settledButton?.props?.children === '一键复盘',
  String(settledButton?.props?.children))

// ── 4. 标题行入口 ───────────────────────────────────────────────────────
log('== header entry')
openedTabs.length = 0
const entryView = render(headerEntry.component, headerEntry.options.inject())
const entryButton = hosts(entryView, 'button')[0]
check('header button text', textOf(entryView).includes('复盘'), textOf(entryView))
entryButton.props.onClick()
check('header button opens the review tab',
  JSON.stringify(openedTabs) === JSON.stringify(['limbs-review']), JSON.stringify(openedTabs))

// ── 5. 标题组件 ─────────────────────────────────────────────────────────
const titleView = render(title.component, {})
check('tab title renders the localized name', textOf(titleView).includes('Limbs 复盘'), textOf(titleView))

// ── 汇总 ───────────────────────────────────────────────────────────────
log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
