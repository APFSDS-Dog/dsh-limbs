/**
 * 模块八 · 项目管理 UI · 段 3（二级页）离线测试。
 *
 * 只验二级页：账表（最近 N 行）· §3.3 待拍板 · STATUS 快照 · devlog 列表
 * （按 id 倒序、点开看正文）· 该项目自己的配置（含热注入开关）。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\projects-detail-test.mjs
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

// ── 微型 React（同 ui-shell-test 的替身）────────────────────────────────
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
  const set = (next) => { frame.states[slot] = typeof next === 'function' ? next(frame.states[slot]) : next }
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
const textOf = (nodes) => nodes
  .map((node) => (node.host === 'text' ? node.text : (typeof node.props?.children === 'string' ? node.props.children : '')))
  .join(' | ')

// ── 浏览器桩 ────────────────────────────────────────────────────────────
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const noop = () => {}
globalThis.window = { setTimeout, clearTimeout }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set id(v) {}, set textContent(v) {}, remove: noop }),
  head: { appendChild: noop },
  addEventListener: noop, removeEventListener: noop, body: {},
}

// ── 装载插件 ────────────────────────────────────────────────────────────
let captured = null
globalThis.window.__ModuleLoader__ = { load: (spec) => { captured = spec } }
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
new Function(source)()
const slots = { inject: (_k, cb) => { cb(); return noop }, register: () => noop }
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  effect: (fn) => { fn(); return noop },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error('unexpected require: ' + name)
})
plugin.apply(ctx)
const { createProjectsStore, LimbsProjectDetail, M8, M8Ledger } = plugin.__test

// ── 假 Host ─────────────────────────────────────────────────────────────
const DETAIL_BODY = {
  ok: true,
  path: 'D:\\Projects\\alpha',
  title: 'alpha',
  registered: true,
  defaults: { inject: true, write: false, ledgerRecent: 10, checkCommand: '' },
  config: { inject: true, write: false, ledgerRecent: 4, checkCommand: 'pwsh -File ./check-docs.ps1' },
  configSources: { inject: 'default', write: 'default', ledgerRecent: 'project', checkCommand: 'project' },
  detail: {
    root: 'D:\\Projects\\alpha',
    ledgerRows: Array.from({ length: 6 }, (_, index) => ({
      id: `t-2026010${index}-01`,
      title: `第 ${index + 1} 件`,
      status: index === 5 ? 'doing' : 'done',
      conclusion: '结论',
      archive: `t-2026010${index}-01`,
      next: '下一步',
    })),
    pending: '| Q9 | 假问题 | 假原因 | A / B | — |',
    decided: '',
    statusSnapshot: '| 项 | 实测值 |\n|---|---|\n| 假项 | 1 |',
    statusCheckedAt: '2026-01-01',
    devlogs: [
      { id: 't-20260105-01', name: 't-20260105-01_测试项.md', title: '第五件', modifiedAt: 5 },
      { id: 't-20260103-01', name: 't-20260103-01_测试项.md', title: '第三件', modifiedAt: 3 },
    ],
    hasProgress: true,
    hasStatus: true,
  },
}

const calls = []
let putResponse = null
function fakeFetch(path, init) {
  const method = init?.method ?? 'GET'
  calls.push({ path, method, body: init?.body })
  if (method === 'PUT') {
    const payload = JSON.parse(init.body)
    const merged = { ...DETAIL_BODY.config, ...payload.config }
    putResponse = {
      ok: true,
      path: payload.path,
      defaults: DETAIL_BODY.defaults,
      config: merged,
      sources: { ...DETAIL_BODY.configSources, ...Object.fromEntries(Object.keys(payload.config).map(k => [k, 'project'])) },
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(putResponse) })
  }
  if (path.startsWith('/limbs/handoff-project') && path.includes('id=')) {
    const id = path.slice(path.indexOf('id=') + 3)
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true,
        devlog: { found: true, id, name: `${id}_测试项.md`, text: `# ${id}\n\n## todos\n\n假的。`, sections: { todos: '假的。' } },
      }),
    })
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DETAIL_BODY) })
}

const bridge = { token: 'ui-token', configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }
const store = createProjectsStore({ bridge, fetchImpl: fakeFetch })
await store.openProject('D:\\Projects\\alpha')
const snapshot = store.getSnapshot()

log('== 二级页：数据')
check('打开项目只发了详情 GET',
  calls.filter(c => c.method === 'GET').length === 1, JSON.stringify(calls.map(c => `${c.method} ${c.path}`)))
check('GET 带 path 参数',
  String(calls[0].path).startsWith('/limbs/handoff-project?path='), calls[0].path)
check('打开项目不发 PUT（只读）', !calls.some(c => c.method === 'PUT'))
check('detail 被收进快照', snapshot.detail?.ledgerRows?.length === 6, String(snapshot.detail?.ledgerRows?.length))
check('项目级配置被收进快照', snapshot.detailConfig?.ledgerRecent === 4,
  JSON.stringify(snapshot.detailConfig))
check('逐项来源被收进快照', snapshot.detailSources?.ledgerRecent === 'project',
  JSON.stringify(snapshot.detailSources))

log('== 二级页：渲染')
const view = render(LimbsProjectDetail, { store, state: snapshot })
const text = textOf(view)
check('有返回按钮', text.includes('返回项目列表'), '')
check('标题显示项目路径', text.includes('alpha'), '')
check('配置区标题在', text.includes('该项目自己的配置'), '')
check('热注入开关在这页（需求原话）', text.includes('热注入'), '')
check('真写开关在这页', text.includes('真写'), '')
check('账表滑窗在这页', text.includes('账表滑窗'), '')
check('自检命令在这页', text.includes('自检命令'), '')
check('来源标记「项目覆盖」出现', text.includes('项目覆盖'), '')
check('来源标记「继承默认」出现', text.includes('继承默认'), '')
check('账表块标题在', text.includes('该项目的任务账'), '')
check('待拍板块标题在', text.includes('待拍板'), '')
check('快照块标题在', text.includes('STATUS 实测快照'), '')
check('核对日期渲染出来', text.includes('2026-01-01'), '')
check('devlog 块标题在', text.includes('devlog'), '')

// 账表滑窗：配置里 ledgerRecent=4，6 行只渲染最后 4 行
const tableRows = view.filter(node => node.type === 'tr')
check('账表按配置的滑窗行数渲染（4 + 表头 1）', tableRows.length === 5, String(tableRows.length))
check('滑窗取的是最后 4 行（第一行 t-20260100-01 不在）',
  !text.includes('t-20260100-01'), '')
check('最后一行 t-20260105-01 在', text.includes('t-20260105-01'), '')

// devlog 列表按 id 倒序
const devlogButtons = hosts(view, 'button').filter(node =>
  String(node.props?.className || '').split(/\s+/).includes('m8-devlog'))
check('devlog 列表两个条目', devlogButtons.length === 2, String(devlogButtons.length))
check('devlog 按 id 倒序（新的在前）',
  String(devlogButtons[0]?.props?.title) === '点一条看正文'
  && text.includes('t-20260105-01') && text.includes('t-20260103-01'), '')

// ── 点开 devlog 看正文 ─────────────────────────────────────────────────
log('== devlog 正文')
await store.openDevlog('D:\\Projects\\alpha', 't-20260105-01')
check('取正文只发了一次 GET',
  calls.filter(c => String(c.path).includes('&id=')).length === 1,
  JSON.stringify(calls.map(c => c.path)))
const afterOpen = render(LimbsProjectDetail, { store, state: store.getSnapshot() })
const afterText = textOf(afterOpen)
check('正文标题带 id', afterText.includes('devlog 正文 t-20260105-01'), '')
check('正文内容渲染出来', afterText.includes('# t-20260105-01'), '')
check('有收起按钮', afterText.includes('收起'), '')

// ── 点热注入开关：必须直达 PUT，且只改 inject ──────────────────────────
log('== 热注入开关（项目主第一诉求）')
const switchNodes = hosts(afterOpen, 'button').filter(node => node.props?.role === 'switch')
check('两个开关（热注入 + 真写）', switchNodes.length === 2, String(switchNodes.length))
const injectSwitch = switchNodes[0]
check('热注入开关当前是开', injectSwitch?.props?.['aria-checked'] === 'true',
  String(injectSwitch?.props?.['aria-checked']))
calls.length = 0
await injectSwitch.props.onClick()
// 组件的 onClick 返回 void（它内部自己发起请求），等一轮微任务让状态落地。
await new Promise(resolve => setTimeout(resolve, 0))
check('点开关发出 PUT', calls.length === 1 && calls[0].method === 'PUT',
  JSON.stringify(calls.map(c => `${c.method} ${c.path}`)))
check('PUT 打到配置接口', calls[0].path === '/limbs/handoff-config', String(calls[0].path))
const putBody = JSON.parse(calls[0].body ?? '{}')
check('PUT 只带 inject 这一个键',
  Object.keys(putBody.config ?? {}).length === 1 && putBody.config.inject === false,
  JSON.stringify(putBody.config))
check('PUT 带上了项目路径', putBody.path === 'D:\\Projects\\alpha', String(putBody.path))

const afterToggle = store.getSnapshot()
check('保存后快照里的 inject 变 false', afterToggle.detailConfig?.inject === false,
  JSON.stringify(afterToggle.detailConfig))
check('保存后来源标成项目覆盖', afterToggle.detailSources?.inject === 'project',
  JSON.stringify(afterToggle.detailSources))
check('保存后有「已保存」提示', afterToggle.toast?.kind === 'ok' && afterToggle.toast.text === '已保存',
  JSON.stringify(afterToggle.toast))

const toggled = render(LimbsProjectDetail, { store, state: afterToggle })
const toggledSwitch = hosts(toggled, 'button').filter(node => node.props?.role === 'switch')[0]
check('重渲染后开关显示为关', toggledSwitch?.props?.['aria-checked'] === 'false',
  String(toggledSwitch?.props?.['aria-checked']))

// ── ledgerRecent 下拉 ──────────────────────────────────────────────────
log('== 账表滑窗下拉')
calls.length = 0
const selectNode = hosts(toggled, 'select')[0]
check('滑窗是下拉，值来自项目配置（4）', String(selectNode?.props?.value) === '4',
  String(selectNode?.props?.value))
selectNode.props.onChange({ target: { value: '15' } })
await new Promise(resolve => setTimeout(resolve, 0))
check('改滑窗发出 PUT 且只带 ledgerRecent',
  calls.length === 1 && JSON.parse(calls[0].body).config.ledgerRecent === 15,
  JSON.stringify(calls.map(c => c.body)))

// ── 自检命令：改草稿不落盘，回车/失焦才落盘 ────────────────────────────
log('== 自检命令（草稿 → 提交）')
calls.length = 0
const freshView = render(LimbsProjectDetail, { store, state: store.getSnapshot() })
const checkInput = hosts(freshView, 'input').find(node =>
  String(node.props?.className || '').includes('m8-inputNarrow'))
check('自检命令是文本框', checkInput !== undefined)
check('文本框值是项目配置里的命令',
  checkInput?.props?.value === 'pwsh -File ./check-docs.ps1', String(checkInput?.props?.value))
checkInput.props.onChange({ target: { value: 'pwsh -File ./check-docs.ps1 --fast' } })
check('只改草稿不发 PUT', calls.length === 0, JSON.stringify(calls.length))
const draftView = render(LimbsProjectDetail, { store, state: store.getSnapshot() })
const draftInput = hosts(draftView, 'input').find(node =>
  String(node.props?.className || '').includes('m8-inputNarrow'))
check('草稿留在输入框里（未提交也看得见）', String(draftInput?.props?.value).includes('--fast'),
  String(draftInput?.props?.value))
calls.length = 0
draftInput.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
await new Promise(resolve => setTimeout(resolve, 0))
check('回车提交 PUT', calls.length === 1 && calls[0].method === 'PUT', JSON.stringify(calls.length))
check('提交的是 trim 过的命令',
  JSON.parse(calls[0]?.body ?? '{}').config?.checkCommand === 'pwsh -File ./check-docs.ps1 --fast',
  String(calls[0]?.body))

// ── 返回列表清状态 ─────────────────────────────────────────────────────
log('== 返回')
store.backToList()
const back = store.getSnapshot()
check('返回后 selected 清空', back.selected === null, String(back.selected))
check('返回后 devlog 关掉', back.devlog === null, JSON.stringify(back.devlog))

// ── 空工程：四块都要有占位说明，不许空白 ───────────────────────────────
log('== 空工程')
{
  const emptyStore = createProjectsStore({
    bridge: { token: 't', configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' },
    fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true, path: 'D:\\Empty', defaults: { inject: true, write: false, ledgerRecent: 10, checkCommand: '' },
        config: { inject: true, write: false, ledgerRecent: 10, checkCommand: '' },
        configSources: {}, detail: {
          root: 'D:\\Empty', ledgerRows: [], pending: '', decided: '',
          statusSnapshot: '', statusCheckedAt: null, devlogs: [], hasProgress: false, hasStatus: false,
        },
      }),
    }),
  })
  await emptyStore.openProject('D:\\Empty')
  const emptyView = render(LimbsProjectDetail, { store: emptyStore, state: emptyStore.getSnapshot() })
  const emptyText = textOf(emptyView)
  check('空账表有占位说明', emptyText.includes('账表为空'), '')
  check('空待拍板有占位说明', emptyText.includes('没有待拍板条目'), '')
  check('空 STATUS 有占位说明', emptyText.includes('未取到'), '')
  check('空 devlog 有占位说明', emptyText.includes('还没有冷存档'), '')
}

// ── 纯渲染小件的边界 ───────────────────────────────────────────────────
log('== 渲染小件')
{
  const ledgerView = render(M8Ledger, { rows: [], limit: 3 })
  check('空账表渲染成占位而不是空表格',
    hosts(ledgerView, 'table').length === 0 && textOf(ledgerView).includes('账表为空'), '')
  const limited = render(M8Ledger, { rows: Array.from({ length: 8 }, (_, i) => ({
    id: `t-x-${i}`, title: 'T', status: 'done', conclusion: 'C', archive: '—', next: '—',
  })), limit: 3 })
  check('limit 生效（3 行 + 表头）', limited.filter(n => n.type === 'tr').length === 4,
    String(limited.filter(n => n.type === 'tr').length))
}

// ── 失败码分档 + 令牌失配自愈（真机 403 的回归）─────────────────────────
//
// 真机现象（2026-11-25）：Host 重载插件会换一个新令牌，页面还拿着旧的 →
// 一级页快照看着正常，二级页的详情 GET 与配置 PUT **两条一起 403 forbidden**。
// 另有一条独立的坑：路径坏了是 400（missing / unregistered / path），
// 若 UI 一律显示「请求失败：没有权限…」，排查者会被带偏到令牌上。
log('== 失败码 / 令牌失配')

const TOKEN_NEW = 'token-new'
const TOKEN_OLD = 'token-old'

/** 造一个「只认新令牌，旧令牌 403 forbidden」的 Host。 */
function staleHost(extra) {
  const seen = { bridge: 0, detail: [], save: [] }
  const fetchImpl = (path, init) => {
    if (path === '/limbs/handoff-bridge') {
      seen.bridge += 1
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          ok: true, token: TOKEN_NEW,
          configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project',
        }),
      })
    }
    const token = init?.headers?.['x-limbs-token']
    if (extra !== undefined) return extra(path, init, token)
    if (init?.method === 'PUT') {
      seen.save.push(token)
      return token === TOKEN_NEW
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, path: 'D:\\Projects\\alpha', config: DETAIL_BODY.config, sources: DETAIL_BODY.configSources }) })
        : Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ ok: false, code: 'forbidden', message: '没有权限读写项目配置。' }) })
    }
    seen.detail.push(token)
    return token === TOKEN_NEW
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DETAIL_BODY) })
      : Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ ok: false, code: 'forbidden', message: '没有权限读取项目详情。' }) })
  }
  return { fetchImpl, seen }
}

{
  // ① 详情 GET：旧令牌 → 403 → 换令牌重试 → 200，界面不再报错
  const host = staleHost()
  const s = createProjectsStore({ bridge: { token: TOKEN_OLD, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }, fetchImpl: host.fetchImpl })
  await s.openProject('D:\\Projects\\alpha')
  const snap = s.getSnapshot()
  check('旧令牌先 403，换令牌后详情仍拿到', snap.phase === 'ready' && snap.detail !== null, snap.phase)
  check('只换了 1 次令牌', host.seen.bridge === 1, String(host.seen.bridge))
  check('重试用的是新令牌', host.seen.detail.join(',') === TOKEN_OLD + ',' + TOKEN_NEW, host.seen.detail.join(','))
  check('详情没有报错文案', snap.error === null, String(snap.error))

  // ② 配置 PUT：同一条路径（二级页的两个开关走它）。这里**换一个新 store**，
  //    让它也从旧令牌起步 —— 上面那个 store 的令牌已经在 ① 里换成新的了。
  const saveHost = staleHost()
  const saveStore = createProjectsStore({ bridge: { token: TOKEN_OLD, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }, fetchImpl: saveHost.fetchImpl })
  await saveStore.saveConfig('D:\\Projects\\alpha', { inject: false })
  const afterSave = saveStore.getSnapshot()
  check('旧令牌保存也自愈（提示是已保存）', afterSave.toast?.kind === 'ok', JSON.stringify(afterSave.toast))
  check('保存也先 403 再换令牌重试',
    saveHost.seen.save.join(',') === TOKEN_OLD + ',' + TOKEN_NEW, saveHost.seen.save.join(','))

}

{
  // ③ 坏路径：400 missing，**不换令牌**，文案必须指向路径
  const host = staleHost((path, init, token) => Promise.resolve({
    ok: false, status: 400,
    json: () => Promise.resolve({ ok: false, code: 'missing', message: '这个路径不存在或不是目录。' }),
  }))
  const s = createProjectsStore({ bridge: { token: TOKEN_NEW, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }, fetchImpl: host.fetchImpl })
  await s.openProject('D:\\Projects\\alpha')
  const snap = s.getSnapshot()
  check('坏 path 不换令牌（非令牌问题）', host.seen.bridge === 0, String(host.seen.bridge))
  check('坏 path 的文案说是路径问题', String(snap.error).includes('路径问题'), String(snap.error))
  check('坏 path 的文案带出来的 code 是 missing', String(snap.error).includes('missing'), String(snap.error))
  check('坏 path 的文案**不**说没有权限', !String(snap.error).includes('没有权限'), String(snap.error))
}

{
  // ④ 未登记目录：400 unregistered，文案指向「不是工作区」
  const host = staleHost((path, init, token) => Promise.resolve({
    ok: false, status: 400,
    json: () => Promise.resolve({ ok: false, code: 'unregistered', message: '该目录既不是 DSH 工作区…' }),
  }))
  const s = createProjectsStore({ bridge: { token: TOKEN_NEW, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }, fetchImpl: host.fetchImpl })
  await s.openProject('D:\\Projects\\nope')
  const snap = s.getSnapshot()
  check('unregistered 文案说是路径/工作区问题', String(snap.error).includes('路径问题'), String(snap.error))
  check('unregistered 文案带出 code', String(snap.error).includes('unregistered'), String(snap.error))
}

{
  // ⑤ 令牌换了也没用（桥接回同一个令牌）：不无限重试，照实报 403
  let bridgeCalls = 0
  const fetchImpl = (path, init) => {
    if (path === '/limbs/handoff-bridge') {
      bridgeCalls += 1
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
        ok: true, token: TOKEN_OLD, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project',
      }) })
    }
    return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ ok: false, code: 'forbidden', message: '没有权限读取项目详情。' }) })
  }
  const s = createProjectsStore({ bridge: { token: TOKEN_OLD, configPath: '/limbs/handoff-config', projectPath: '/limbs/handoff-project' }, fetchImpl })
  await s.openProject('D:\\Projects\\alpha')
  const snap = s.getSnapshot()
  check('令牌没变时不重试、照实报错', String(snap.error).includes('令牌'), String(snap.error))
  check('令牌没变时只问了一次桥接', bridgeCalls === 1, String(bridgeCalls))
}

log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
