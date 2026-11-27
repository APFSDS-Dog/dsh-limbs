/**
 * 模块三 · UI 壳子离线测试（不启动 DSH、不联网、不装 jsdom）。
 *
 * 验证三件事：
 *   1. 注册面：settings.section / sidebarRightTabs / sidebar.right.pane.tab /
 *      sidebar.right.pane.tab.title / conversation.session.header.utilities
 *      都以正确的 id、order、key 出现，且旧的选择器席位没被弄坏。
 *   2. 设置页走 Host Config（假 `configForms`）：读写经官方接口，不再落
 *      localStorage；两个字段是真实枚举，默认值来自 Host 侧规格。
 *   3. 复盘面板走真数据：下拉来自 `modelDirectories`，「一键复盘」经
 *      `remote.commands` 跑 `/limbs-review`，报告区把 Markdown 渲染成 HTML
 *      （含 XSS 转义断言）。
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
// ⚠️ `useRef` 必须**跨渲染持久**（真 React 就是这样）：面板用 ref 记住
// 「已经为哪个会话读过盘」，如果这里每次 render 都返回全新 `{current}`，
// 那道判据永远为假 → 切会话的断言会被测成「读了好几次」的假红。
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
const useEffect = (effect) => { current.cursor += 1; effect() }
const useRef = (initial) => {
  const frame = current
  const slot = frame.refCursor++
  if (!(slot in frame.refs)) frame.refs[slot] = { current: initial }
  return frame.refs[slot]
}
const useCallback = (fn) => { current.cursor += 1; return fn }
const useMemo = (fn) => { current.cursor += 1; return fn() }
const useSyncExternalStore = (subscribe, getSnapshot) => {
  current.cursor += 1
  subscribe(() => {})
  return getSnapshot()
}
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
  check('rendered-markdown CSS present', cssBody.includes('.limbs-md table') && cssBody.includes('.limbs-md pre'))
}
check('bundle has no obvious unresolved placeholder', !source.includes('TODO:') && !source.includes('FIXME:'))
// The mock surface must be gone for good: no fake catalogue, no fake report,
// no "mock data" badge, no placeholder trigger line.
check('MOCK_PANEL_MODELS is gone', !source.includes('MOCK_PANEL_MODELS'))
check('MOCK_REPORT is gone', !source.includes('MOCK_REPORT'))
check('the "mock data" badge copy is gone', !source.includes('假数据') && !source.includes("reviewMock"))
check('the placeholder trigger copy is gone',
  !source.includes('占位触发') && !source.includes('reviewTriggered') && !source.includes('触发复盘'))
check('the settings placeholder notice is gone', !source.includes('当前为界面占位') && !source.includes('settingsMock'))

// ── 1. 假 Host 接口（configForms + remote.commands + modelDirectories）──
// 官方 `ctx.configForms.get(entryId)` 的窄面：快照 + 订阅 + 一次写入。
const configFormsState = {
  value: { effort: 'medium', costWarn: true },
  revision: 1,
  writable: true,
  status: 'ready',
}
const configFormListeners = new Set()
const configFormWrites = []
const configForms = {
  get: (entryId) => ({
    getSnapshot: () => ({
      status: configFormsState.status,
      value: { ...configFormsState.value },
      revision: configFormsState.revision,
      writable: configFormsState.writable,
    }),
    subscribe: (listener) => { configFormListeners.add(listener); return () => { configFormListeners.delete(listener) } },
    set: (field, value) => {
      configFormWrites.push({ entryId, field, value })
      configFormsState.value = { ...configFormsState.value, [field]: value }
      configFormsState.revision += 1
      for (const listener of Array.from(configFormListeners)) listener()
      return Promise.resolve(true)
    },
  }),
}

// 真实模型目录形状（与模块一读的同一个 store）。
const directoryState = {
  current: { provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017-Event' },
  groups: [
    {
      id: 'scnet',
      name: '超算互联网scnet',
      models: [
        { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' },
        { id: 'DeepSeek-V4.1-Flash-1017-Event', name: 'DeepSeek-V4.1-Flash-1017-Event' },
      ],
    },
    {
      id: 'tokenrhythm',
      name: '基元流动tokenrhythm',
      models: [{ id: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017' }],
    },
  ],
  failures: [],
  status: 'ready',
  pending: null,
  error: null,
}
const directoryListeners = new Set()
const directorySelections = []
// 与官方 `ctx.modelDirectories.directoryFor(sessionId)` 同形：`{ store, load, select }`。
const directoryStore = {
  getSnapshot: () => directoryState,
  subscribe: (listener) => { directoryListeners.add(listener); return () => { directoryListeners.delete(listener) } },
}
const directory = {
  store: directoryStore,
  load: () => Promise.resolve(directoryState),
  select: (selection) => {
    directorySelections.push(selection)
    directoryState.current = { provider: selection.provider, model: selection.model }
    return Promise.resolve({ ok: true })
  },
}

// 报告内容故意带上 HTML 注入：转义断言靠它。
const REAL_REPORT = [
  '# 会话复盘 · 效率诊断',
  '',
  '> 会话 `test-0001` · 事件 12 条',
  '',
  '### 一、总账',
  '',
  '| 指标 | 数值 |',
  '|---|---|',
  '| 模型请求 | 2 次 |',
  '| 工具调用 | 4 次 |',
  '',
  '### 二、费用大头',
  '',
  '1. **`read`** — 详情：读取 `src/big.js`',
  '2. **`pwsh`** — 详情：跑一次命令',
  '',
  '- 诊断一：重复调用',
  '  - 说明：同一签名出现 3 次',
  '',
  '```',
  '<script>alert("xss")</script>',
  '```',
  '',
  '原始注入：<img src=x onerror=alert(1)>',
  '',
  '_报告到此结束。_',
].join('\n')

const reviewCalls = []
const remoteCommands = {
  execute: (sessionId, line) => {
    reviewCalls.push({ sessionId, line })
    return Promise.resolve({
      ok: true,
      value: { commandId: 'cmd:1', result: { kind: 'success', text: REAL_REPORT } },
    })
  },
}

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
    if (name === 'configForms') return configForms
    if (name === 'modelDirectories') return { directoryFor: () => directory }
    if (name === 'sessions') return { subagentAddress: () => undefined }
    if (name === 'remote.commands') return remoteCommands
    if (name === 'remote') return { commands: remoteCommands }
    return undefined
  },
  effect: (fn) => { fn(); return noop },
}

const plugin = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})
plugin.apply(ctx)
const testApi = plugin.__test

// ── 2. 注册面 ───────────────────────────────────────────────────────────
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
check('pane body carries a per-session inject face', typeof body?.options.inject === 'function')

const headerEntry = (registry.get('conversation.session.header.utilities') || [])[0]
check('header entry registered', headerEntry !== undefined)
check('header entry id', headerEntry?.options.id === 'limbs-review')
check('header entry order between schedule and unlag', headerEntry?.options.order === 28)
check('model seat still shadows the stock one (no regression)',
  (registry.get('conversation.input.model') || []).some((entry) => entry.options.priority === -1))

// ── 3. 设置页（Host Config）─────────────────────────────────────────────
log('== settings section (Host Config)')
const settingsView = render(settings.component, {})
const selects = hosts(settingsView, 'select')
const switchNode = settingsView.find((node) => node.props?.role === 'switch')
check('one dropdown left after dropping the context row', selects.length === 1, String(selects.length))
const effortOptions = (selects[0]?.props.children || []).map((option) => option.props.children)
check('effort choices are the real enum and localized',
  JSON.stringify(effortOptions) === JSON.stringify(['关闭', '服务商默认', '低', '中', '高', '最高']),
  JSON.stringify(effortOptions))
check('the page reads the Host value, not a local default',
  selects[0]?.props.value === 'medium', String(selects[0]?.props.value))
check('switch exposes aria-checked', switchNode?.props?.['aria-checked'] === 'true',
  String(switchNode?.props?.['aria-checked']))
check('switch is a native button', switchNode?.type === 'button')
check('no placeholder notice on a healthy page',
  !textOf(settingsView).includes('占位') && !textOf(settingsView).includes('configForms'),
  textOf(settingsView).slice(0, 160))
check('controls are enabled when the Host accepts writes',
  selects[0]?.props.disabled === false && switchNode?.props?.disabled !== true)

selects[0].props.onChange({ target: { value: '1m' } })
check('effort write goes through configForms', configFormWrites.at(-1)?.field === 'effort'
  && configFormWrites.at(-1)?.value === '1m', JSON.stringify(configFormWrites.at(-1)))
check('effort write targets the dsh-limbs entry', configFormWrites.at(-1)?.entryId === 'dsh-limbs',
  String(configFormWrites.at(-1)?.entryId))
check('the old localStorage key is never written', storage.has('dsh-limbs:settings') === false,
  JSON.stringify([...storage.keys()]))

switchNode.props.onClick()
check('switch write goes through configForms', configFormWrites.at(-1)?.field === 'costWarn'
  && configFormWrites.at(-1)?.value === false, JSON.stringify(configFormWrites.at(-1)))

// `useSyncExternalStore` 要求 getSnapshot 在数据未变时返回**同一引用**；
// 每次 new 一个对象会让 React 判定「状态一直在变」并无限重渲染，
// 最终 `Maximum update depth exceeded` → 整个设置分区白屏（真机踩过）。
const settingsStore = testApi.createLimbsSettingsStore(configForms.get('dsh-limbs'))
const firstSnapshot = settingsStore.read()
const secondSnapshot = settingsStore.read()
check('the settings snapshot is referentially stable while nothing changed',
  firstSnapshot === secondSnapshot,
  'read() returned a fresh object on every call — React will re-render forever')

const settingsAgain = render(settings.component, {})
const switchAgain = settingsAgain.find((node) => node.props?.role === 'switch')
check('re-render reflects the Host value (switch off)', switchAgain?.props?.['aria-checked'] === 'false',
  String(switchAgain?.props?.['aria-checked']))
check('re-render reflects the Host value (effort 1m)',
  hosts(settingsAgain, 'select')[0]?.props.value === '1m',
  String(hosts(settingsAgain, 'select')[0]?.props.value))

// 只读 / 缺席两种降级：要明说原因，且控件不可用。
configFormsState.writable = false
configFormsState.revision += 1
for (const listener of Array.from(configFormListeners)) listener()
const readOnlyView = render(settings.component, {})
check('a read-only Host disables the dropdowns', hosts(readOnlyView, 'select')[0]?.props.disabled === true)
check('a read-only Host explains itself', textOf(readOnlyView).includes('不接受写入'),
  textOf(readOnlyView).slice(0, 160))
configFormsState.writable = true
configFormsState.revision += 1
for (const listener of Array.from(configFormListeners)) listener()

const noFormsView = render(testApi.makeLimbsSettingsSection({
  get: (name) => (name === 'slots' ? slots : undefined),
}), {})
check('a missing configForms still renders the page', hosts(noFormsView, 'select').length === 1)
check('a missing configForms explains itself', textOf(noFormsView).includes('这几项暂时改不了'),
  textOf(noFormsView).slice(0, 160))

// ── 4. 复盘面板（真数据）───────────────────────────────────────────────
log('== review panel (real data)')
const face = body.options.inject('session:test-0001')
check('gate knows its session', face.sessionId === 'session:test-0001', String(face.sessionId))
check('gate exposes the model store (snapshot + subscribe)', face.store !== null
  && typeof face.store.getSnapshot === 'function' && typeof face.store.subscribe === 'function')
check('gate exposes the directory writer', typeof face.select === 'function')
check('gate exposes one review action', typeof face.runReview === 'function')
// B2：还要暴露「读回上次落盘的那份」。没有它 = 切走会话就看不到报告。
check('gate exposes the saved-report reader', typeof face.readSaved === 'function')

const panelView = render(body.component, face)
const runButton = byClass(panelView, 'limbs-run')
check('run button exists', runButton !== undefined)
check('run button label is 一键复盘', runButton?.props?.children === '一键复盘', String(runButton?.props?.children))
check('quick model switch is a select', hosts(panelView, 'select').length === 1)
const modelSelect = hosts(panelView, 'select')[0]
check('model select lists the real directory', (modelSelect?.props.children || []).length === 2,
  String((modelSelect?.props.children || []).length))
const modelGroups = (modelSelect?.props.children || []).filter((node) => node.type === 'optgroup')
check('models are grouped by provider', modelGroups.length === 2, String(modelGroups.length))
check('first provider is the real one', modelGroups[0]?.props.label === '超算互联网scnet',
  String(modelGroups[0]?.props.label))
check('provider options carry real model ids',
  (modelGroups[0]?.props.children || []).map((option) => option.props.value).join(',')
    === 'scnet/GLM-5.3-Flash,scnet/DeepSeek-V4.1-Flash-1017-Event',
  (modelGroups[0]?.props.children || []).map((option) => option.props.value).join(','))
check('the current model is selected', modelSelect?.props.value === 'scnet/DeepSeek-V4.1-Flash-1017-Event',
  String(modelSelect?.props.value))
check('no mock badge on the panel', !textOf(panelView).includes('假数据'), textOf(panelView).slice(0, 120))
check('report area starts empty with an instruction',
  byClass(panelView, 'limbs-reportEmpty') !== undefined
  && textOf(panelView).includes('还没有报告'), textOf(panelView).slice(0, 160))

// 换模型走真目录
modelSelect.props.onChange({ target: { value: 'tokenrhythm/deepseek-v4.1-flash-1017' } })
check('changing the dropdown selects through modelDirectories',
  directorySelections.at(-1)?.provider === 'tokenrhythm'
  && directorySelections.at(-1)?.model === 'deepseek-v4.1-flash-1017',
  JSON.stringify(directorySelections.at(-1)))

// 「一键复盘」→ remote.commands.execute('/limbs-review') → Markdown 渲染
logs.length = 0
runButton.props.onClick()
check("no placeholder console.log line", logs.length === 0, JSON.stringify(logs))
const runningView = render(body.component, face)
const runningButton = byClass(runningView, 'limbs-run')
check('button switches to the running state', runningButton?.props?.children === '正在复盘…',
  String(runningButton?.props?.children))
check('button is disabled while running', runningButton?.props?.disabled === true)

await new Promise((resolve) => setTimeout(resolve, 40))
check('review ran the module-3 command', reviewCalls.length === 1
  && reviewCalls[0].line === '/limbs-review', JSON.stringify(reviewCalls))
check('review ran against this session', reviewCalls[0]?.sessionId === 'session:test-0001')

const settledView = render(body.component, face)
const report = byClass(settledView, 'limbs-md')
check('report area renders the real report', report !== undefined
  && typeof report.props?.dangerouslySetInnerHTML?.__html === 'string')
const reportHtml = String(report?.props?.dangerouslySetInnerHTML?.__html || '')
check('report was converted from markdown (heading)', reportHtml.includes('<h1>'), reportHtml.slice(0, 120))
check('report kept the table', reportHtml.includes('<table>') && reportHtml.includes('<th>指标</th>'),
  reportHtml.slice(0, 200))
check('report kept the ordered list', reportHtml.includes('<ol>') && reportHtml.includes('<li>'),
  reportHtml.slice(0, 200))
check('report kept the nested list', reportHtml.includes('<li>诊断一：重复调用') && reportHtml.includes('<ul>'),
  reportHtml.slice(0, 240))
check('report kept the fenced code block', reportHtml.includes('<pre><code>'), reportHtml.slice(0, 240))
check('report renders bold inside a list item', reportHtml.includes('<strong>'), reportHtml.slice(0, 240))
check('report renders inline code', reportHtml.includes('<code>read</code>') || reportHtml.includes('<code>src/big.js</code>'),
  reportHtml.slice(0, 320))
check('report kept the blockquote', reportHtml.includes('<blockquote>'), reportHtml.slice(0, 200))

// XSS：报告里的标签必须变成实体，不能被浏览器执行
check('script tag is escaped', !reportHtml.includes('<script') && reportHtml.includes('&lt;script&gt;'),
  reportHtml.slice(reportHtml.indexOf('script') - 20, reportHtml.indexOf('script') + 60))
check('img/onerror payload is escaped', !reportHtml.includes('<img') && reportHtml.includes('&lt;img src=x onerror='),
  reportHtml.slice(-260))
const escapeChecks = reportHtml.match(/<[^>]*>|&[a-z]+;?/g) || []
const allowedTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tr', 'th', 'td',
  'tbody', 'pre', 'code', 'strong', 'em', 'blockquote', 'hr'])
const strayTags = (reportHtml.match(/<\/?([a-z0-9]+)[^>]*>/gi) || [])
  .map((tag) => tag.replace(/[<>/]/g, '').split(' ')[0].toLowerCase())
  .filter((name) => !allowedTags.has(name))
check('only renderer-emitted tags survive', strayTags.length === 0, JSON.stringify(strayTags))
check('no raw quote survives unescaped inside a tag we emitted',
  !/<(?:p|li|td|th|h\d)[^>]*"/.test(reportHtml.replace(/ class="[^"]*"/g, '')))

const settledButton = byClass(settledView, 'limbs-run')
check('button turns into 重新复盘 once a report is on screen',
  settledButton?.props?.children === '重新复盘', String(settledButton?.props?.children))

// 失败面：命令报错时给可读原因，不静默、不假装有报告
// 微型 React 的 state 按组件函数保存，所以这里套一层新函数取得干净状态。
function FailingPanel(props) { return testApi.LimbsReviewPanel(props) }
const failingFace = {
  store: directoryStore,
  select: directory.select,
  runReview: () => Promise.reject(new Error('会话不在内存 Session 注册表')),
}
const failingView = render(FailingPanel, failingFace)
const failingRun = byClass(failingView, 'limbs-run')
failingRun.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
const failedView = render(FailingPanel, failingFace)
const failedNotice = byClass(failedView, 'limbs-runNotice')
check('a failed review shows a readable reason',
  failedNotice !== undefined && String(failedNotice.props.children).includes('会话不在内存 Session 注册表'),
  JSON.stringify(failedNotice?.props?.children))
check('a failed review leaves the report area empty', byClass(failedView, 'limbs-md') === undefined)

// ── 4b. B2：打开面板先读落盘文件 / 标生成时间 / 重新复盘覆盖 ─────────────
log('== review panel · saved report (B2)')

// 假的好盘文件：一份已生成过的报告 + 一个可读的时间戳。
const SAVED_AT = 1_763_000_000_000
const savedFace = {
  store: directoryStore,
  select: directory.select,
  // 面板按会话注入：会话 id 也是读盘的一部分（切会话要重读）。
  sessionId: 'session:test-0001',
  runReview: () => Promise.resolve(REAL_REPORT),
  readSaved: () => Promise.resolve({ found: true, markdown: REAL_REPORT, generatedAt: SAVED_AT }),
}

function SavedPanel(props) { return testApi.LimbsReviewPanel(props) }
const savedView = render(SavedPanel, savedFace)
// 读盘是异步的：等一拍再渲染。
await new Promise((resolve) => setTimeout(resolve, 20))
const reopenedView = render(SavedPanel, savedFace)
const reopenedReport = byClass(reopenedView, 'limbs-md')
check('panel opens straight into the saved report (no button press)',
  reopenedReport !== undefined && typeof reopenedReport.props?.dangerouslySetInnerHTML?.__html === 'string',
  JSON.stringify(Object.keys(reopenedReport?.props || {})))
check('saved report reads back the same markdown',
  String(reopenedReport?.props?.dangerouslySetInnerHTML?.__html || '').includes('会话复盘'),
  String(reopenedReport?.props?.dangerouslySetInnerHTML?.__html || '').slice(0, 80))
const whenNode = byClass(reopenedView, 'limbs-reportWhen')
check('the saved report is labelled with its generation time', whenNode !== undefined,
  textOf(reopenedView).slice(0, 200))
check('the label reads 生成于 + a real timestamp',
  String(whenNode?.props?.children || '').startsWith('生成于 ')
  && String(whenNode?.props?.children || '').includes(String(new Date(SAVED_AT).getFullYear()),
    ), String(whenNode?.props?.children))
check('no "not saved" warning when the file reads back',
  byClass(reopenedView, 'limbs-storageNotice') === undefined)
const reopenedButton = byClass(reopenedView, 'limbs-run')
check('the primary button becomes 重新复盘 for a saved report',
  reopenedButton?.props?.children === '重新复盘', String(reopenedButton?.props?.children))

// 「重新复盘」→ 覆盖：再点一次，报告与时间都要跟着更新到最新一次。
let rerunSavedAt = SAVED_AT
const rerunFace = {
  store: directoryStore,
  select: directory.select,
  sessionId: 'session:test-0001',
  runReview: () => {
    rerunSavedAt = SAVED_AT + 60_000
    return Promise.resolve(REAL_REPORT.replace('事件 12 条', '事件 14 条'))
  },
  readSaved: () => Promise.resolve({ found: true, markdown: REAL_REPORT, generatedAt: rerunSavedAt }),
}
function RerunPanel(props) { return testApi.LimbsReviewPanel(props) }
const rerunView = render(RerunPanel, rerunFace)
await new Promise((resolve) => setTimeout(resolve, 20))
render(RerunPanel, rerunFace)                                  // 第一次：读回旧文件
const rerunButton = byClass(render(RerunPanel, rerunFace), 'limbs-run')
rerunButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
const rerunAfter = render(RerunPanel, rerunFace)
const rerunReport = String(byClass(rerunAfter, 'limbs-md')?.props?.dangerouslySetInnerHTML?.__html || '')
check('重新复盘 replaces the report body with the fresh one', rerunReport.includes('事件 14 条'),
  rerunReport.slice(0, 80))
check('重新复盘 refreshes the generation time label',
  String(byClass(rerunAfter, 'limbs-reportWhen')?.props?.children || '').includes('生成于 '),
  String(byClass(rerunAfter, 'limbs-reportWhen')?.props?.children))

// 落盘失败（只读权限档）：报告照显示，另给一条可读提示，且不出现假时间
const unsavedFace = {
  store: directoryStore,
  select: directory.select,
  sessionId: 'session:test-0001',
  runReview: () => Promise.resolve(REAL_REPORT),
  readSaved: () => Promise.resolve({ found: false, markdown: null, generatedAt: null }),
}
function UnsavedPanel(props) { return testApi.LimbsReviewPanel(props) }
const unsavedView = render(UnsavedPanel, unsavedFace)
await new Promise((resolve) => setTimeout(resolve, 20))
const unsavedPanel = render(UnsavedPanel, unsavedFace)
byClass(unsavedPanel, 'limbs-run').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
const unsavedAfter = render(UnsavedPanel, unsavedFace)
check('a report that did not reach disk is still shown',
  byClass(unsavedAfter, 'limbs-md') !== undefined)
// 文案已从「没有落盘」改成「没确认落盘」—— 因为「读不回来」不等于「没写进去」：
// 令牌失配（Host 换了一次令牌、页面还拿着旧的）也会走到这条分支，而那时
// 文件其实**已经**写进 reviews/ 了。说「没落盘」是撒谎，说「没确认」才对。
check('an unsaved report explains itself instead of pretending',
  byClass(unsavedAfter, 'limbs-storageNotice') !== undefined
  && textOf(unsavedAfter).includes('没确认落盘'), textOf(unsavedAfter).slice(0, 200))
check('unsaved notice points at the diagnosis file instead of listing guesses',
  byClass(unsavedAfter, 'limbs-storageNotice') !== undefined
  && textOf(unsavedAfter).includes('host-status.json'),
  textOf(unsavedAfter).slice(0, 260))
check('no generation-time label when nothing was stored',
  byClass(unsavedAfter, 'limbs-reportWhen') === undefined,
  textOf(unsavedAfter).slice(0, 160))

// 读盘就失败（Host 路由没挂上）：必须安静降级成空态，不能崩、不能报红
function BrokenReadPanel(props) { return testApi.LimbsReviewPanel(props) }const brokenReadFace = {
  store: directoryStore,
  select: directory.select,
  runReview: () => Promise.resolve(REAL_REPORT),
  readSaved: () => Promise.reject(new Error('bridge missing')),
}
const brokenView = render(BrokenReadPanel, brokenReadFace)
await new Promise((resolve) => setTimeout(resolve, 20))
const brokenAfter = render(BrokenReadPanel, brokenReadFace)
check('a failing saved-report read degrades to the empty state',
  byClass(brokenAfter, 'limbs-reportEmpty') !== undefined
  && byClass(brokenAfter, 'limbs-runNotice') === undefined, textOf(brokenAfter).slice(0, 160))

// 面板没有 readSaved（旧 face / 离线注入）：行为回到「只能生成」而不报错
const noReaderFace = { store: directoryStore, select: directory.select, runReview: () => Promise.resolve(REAL_REPORT) }
function NoReaderPanel(props) { return testApi.LimbsReviewPanel(props) }
const noReaderView = render(NoReaderPanel, noReaderFace)
check('a face without a saved-report reader still renders',
  byClass(noReaderView, 'limbs-run') !== undefined)

// 读回请求本身的判据：无 bridge 全局 → 走兜底桥接；每一步都失败 → 空态
check('the saved-report reader tolerates a missing fetch bridge (no throw)',
  await testApi.limbsSavedReportRequest('session:test-0001')
    .then((value) => value.found === false, () => false))

// ── 4c. 切会话：面板必须重新读盘（B2 的原始诉求）─────────────────────────
log('== review panel · session switch (B2 core)')
// 一个面，按当前会话返回不同的落盘报告 —— 模拟「A 会话有报告、B 会话没有」。
const switchState = { session: 'session:A', reads: 0 }
const switchFace = {
  store: directoryStore,
  select: directory.select,
  get sessionId() { return switchState.session },
  runReview: () => Promise.resolve(REAL_REPORT),
  readSaved: () => {
    switchState.reads += 1
    if (switchState.session === 'session:A') {
      return Promise.resolve({ found: true, markdown: REAL_REPORT, generatedAt: SAVED_AT })
    }
    return Promise.resolve({ found: false, markdown: null, generatedAt: null })
  },
}
function SwitchPanel() { return testApi.LimbsReviewPanel(switchFace) }
render(SwitchPanel)                                           // A 会话：读盘
await new Promise((resolve) => setTimeout(resolve, 20))
const sessionAView = render(SwitchPanel)
check('session A opens with its own saved report',
  byClass(sessionAView, 'limbs-md') !== undefined
  && byClass(sessionAView, 'limbs-reportWhen') !== undefined,
  textOf(sessionAView).slice(0, 120))
check('session A read the file exactly once', switchState.reads === 1, String(switchState.reads))

// 切到 B（没有落盘报告）：必须重新读盘，并且把 A 的报告从屏幕上撤掉。
switchState.session = 'session:B'
render(SwitchPanel)
await new Promise((resolve) => setTimeout(resolve, 20))
const sessionBView = render(SwitchPanel)
check('switching sessions triggers a fresh read', switchState.reads === 2, String(switchState.reads))
check('session B does not show session A report',
  byClass(sessionBView, 'limbs-md') === undefined, textOf(sessionBView).slice(0, 160))
check('session B shows the empty state instead',
  byClass(sessionBView, 'limbs-reportEmpty') !== undefined, textOf(sessionBView).slice(0, 160))
check('session B has no stale generation time',
  byClass(sessionBView, 'limbs-reportWhen') === undefined)

// 切回 A：再读一次（不是复用缓存），报告回来
switchState.session = 'session:A'
render(SwitchPanel)
await new Promise((resolve) => setTimeout(resolve, 20))
const backToA = render(SwitchPanel)
check('switching back re-reads the file (no stale cache)', switchState.reads === 3, String(switchState.reads))
check('session A report is back after switching back',
  byClass(backToA, 'limbs-md') !== undefined && byClass(backToA, 'limbs-reportWhen') !== undefined,
  textOf(backToA).slice(0, 120))

// ── 5. 标题行入口 ───────────────────────────────────────────────────────
log('== header entry')
openedTabs.length = 0
const entryView = render(headerEntry.component, headerEntry.options.inject())
const entryButton = hosts(entryView, 'button')[0]
check('header button text', textOf(entryView).includes('复盘'), textOf(entryView))
entryButton.props.onClick()
check('header button opens the review tab',
  JSON.stringify(openedTabs) === JSON.stringify(['limbs-review']), JSON.stringify(openedTabs))

// ── 6. 标题组件 ─────────────────────────────────────────────────────────
const titleView = render(title.component, {})
check('tab title renders the localized name', textOf(titleView).includes('Limbs 复盘'), textOf(titleView))

// ── 汇总 ───────────────────────────────────────────────────────────────
log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
