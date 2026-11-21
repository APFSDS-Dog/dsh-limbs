#!/usr/bin/env node
/**
 * Dev-only test for the "配置 → 设置 · 模型" navigation in lib/client.js.
 *
 * The helper is an internal of the plugin factory, so the source block is
 * extracted and evaluated against a minimal fake DOM instead of importing it.
 * Two shell layouts are covered:
 *   A. a dedicated `aria-haspopup="dialog"` trigger labelled 设置;
 *   B. 设置 as a row inside the account menu (`aria-haspopup="menu"`, 账号菜单),
 *      which is the launcher the shipped build mounts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// ── extract the block under test ───────────────────────────────────────────
const start = source.indexOf('const SETTINGS_NAV_TEXT')
const endMarker = '\n    /** Case-insensitive substring match'
const end = source.indexOf(endMarker)
if (start < 0 || end < 0) throw new Error('could not locate the settings block in lib/client.js')
const block = source.slice(start, end)

// ── minimal fake DOM ──────────────────────────────────────────────────────
class El {
  constructor(tag, attrs = {}, text = '', hidden = false) {
    this.tag = tag
    this.attrs = attrs
    this.ownText = text
    this.hidden = hidden
    this.children = []
    this.parent = null
    this.clicked = 0
    this.onClick = null
    this.offsetParent = hidden ? null : {}
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('')
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  contains(node) {
    for (let n = node; n !== null && n !== undefined; n = n.parent) if (n === this) return true
    return false
  }
  closest(selector) {
    for (let n = this; n !== null && n !== undefined; n = n.parent) {
      if (matches(n, selector)) return n
    }
    return null
  }
  getClientRects() {
    return this.hidden ? [] : [{ width: 10, height: 10 }]
  }
  querySelector(selector) {
    for (const el of this.walk()) if (matches(el, selector)) return el
    return null
  }
  querySelectorAll(selector) {
    const out = []
    for (const el of this.walk()) if (matches(el, selector)) out.push(el)
    return out
  }
  click() {
    this.clicked += 1
    if (typeof this.onClick === 'function') this.onClick()
  }
  *walk() {
    for (const child of this.children) {
      yield child
      yield* child.walk()
    }
  }
}

function matches(el, selector) {
  const parts = selector.split(',').map((s) => s.trim())
  return parts.some((part) => {
    if (/^[a-z]+$/.test(part)) return el.tag === part
    if (part === 'nav button') return el.tag === 'button' && el.parent !== null && el.parent.tag === 'nav'
    if (part === '.limbs-menu') return el.attrs.class === 'limbs-menu'
    const attr = /^(\w*)\[([\w-]+)="([^"]*)"\]$/.exec(part)
    if (attr !== null) {
      const tagOk = attr[1] === '' || el.tag === attr[1]
      return tagOk && el.getAttribute(attr[2]) === attr[3]
    }
    throw new Error('fake DOM does not support selector: ' + part)
  })
}

function makeDocument(docRoot) {
  return {
    querySelector(selector) {
      for (const el of docRoot.walk()) if (matches(el, selector)) return el
      return null
    },
    querySelectorAll(selector) {
      const out = []
      for (const el of docRoot.walk()) if (matches(el, selector)) out.push(el)
      return out
    },
  }
}

/** Deterministic timers: flush() runs whatever the interval scheduled. */
function makeClock() {
  const timers = new Map()
  let nextId = 1
  return {
    api: {
      setInterval(fn) {
        const id = nextId++
        timers.set(id, fn)
        return id
      },
      clearInterval(id) {
        timers.delete(id)
      },
    },
    flush(times = 60) {
      for (let i = 0; i < times; i++) {
        if (timers.size === 0) return i
        for (const [id, fn] of [...timers]) {
          if (timers.has(id)) fn()
        }
      }
      return times
    },
    pending() {
      return timers.size
    },
  }
}

function run(block, { docRoot, locale = 'zh' }) {
  const document = makeDocument(docRoot)
  const clock = makeClock()
  const window = clock.api
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'window', 'LOCALE', block + '\nreturn { openModelsSettings, settingsTrigger, clickSettingsMenuItem }')
  return { api: factory(document, window, locale), clock }
}

// ── fixtures ──────────────────────────────────────────────────────────────
/** Layout B: account menu button, whose menu row is created on click. */
function layoutB() {
  const body = new El('body')
  const account = body.append(new El('button', { 'aria-haspopup': 'menu', 'aria-label': '账号菜单' }, '半个大西瓜'))
  const nav = body.append(new El('div'))
  const panelHost = body.append(new El('div'))
  let menu = null
  account.onClick = () => {
    if (menu !== null) return
    menu = body.append(new El('div', { role: 'menu' }))
    const settingsRow = menu.append(new El('button', {}, '设置'))
    settingsRow.onClick = () => {
      // The real shell mounts the panel with its nav on the next tick.
      const panel = panelHost.append(new El('div', { 'data-shortcut-modal': 'settings' }))
      const panelNav = panel.append(new El('nav'))
      for (const label of ['通用', '模型', '外观']) panelNav.append(new El('button', {}, label))
    }
    menu.append(new El('button', {}, '意见反馈'))
  }
  return { body, account, nav }
}

/** Layout A: a dedicated settings trigger that opens the panel directly. */
function layoutA() {
  const body = new El('body')
  const trigger = body.append(new El('button', { 'aria-haspopup': 'dialog', 'aria-label': '设置' }, ''))
  const panelHost = body.append(new El('div'))
  trigger.onClick = () => {
    const panel = panelHost.append(new El('div', { 'data-shortcut-modal': 'settings' }))
    const panelNav = panel.append(new El('nav'))
    for (const label of ['通用', '模型']) panelNav.append(new El('button', {}, label))
  }
  return { body, trigger }
}

// ── assertions ────────────────────────────────────────────────────────────
let failed = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log('PASS ' + label)
  } else {
    failed += 1
    console.log('FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

function modelsCellClicked(body, label = '模型') {
  for (const el of body.walk()) {
    if (el.tag === 'button' && el.textContent === label) return el.clicked > 0
  }
  return false
}

function panelOpen(body) {
  for (const el of body.walk()) if (el.getAttribute('data-shortcut-modal') === 'settings') return true
  return false
}

// Layout B: account menu → 设置 row → 模型 cell.
{
  const { body, account } = layoutB()
  const { api, clock } = run(block, { docRoot: body })
  api.openModelsSettings()
  check('B: account menu was clicked', account.clicked === 1, 'clicked=' + account.clicked)
  clock.flush(5)
  check('B: settings panel opened', panelOpen(body))
  check('B: 模型 section clicked', modelsCellClicked(body))
  check('B: interval cleared once done', clock.pending() === 0)
}

// Layout A: dedicated trigger.
{
  const { body, trigger } = layoutA()
  const { api, clock } = run(block, { docRoot: body })
  api.openModelsSettings()
  check('A: dialog trigger was clicked', trigger.clicked === 1, 'clicked=' + trigger.clicked)
  clock.flush(5)
  check('A: settings panel opened', panelOpen(body))
  check('A: 模型 section clicked', modelsCellClicked(body))
}

// Panel already open: go straight to the section, click nothing else.
{
  const body = new El('body')
  const account = body.append(new El('button', { 'aria-haspopup': 'menu', 'aria-label': '账号菜单' }))
  const panel = body.append(new El('div', { 'data-shortcut-modal': 'settings' }))
  const nav = panel.append(new El('nav'))
  const general = nav.append(new El('button', {}, '通用'))
  const models = nav.append(new El('button', {}, '模型'))
  const { api, clock } = run(block, { docRoot: body })
  api.openModelsSettings()
  check('C: existing panel goes straight to 模型', models.clicked === 1 && general.clicked === 0)
  check('C: no launcher click when panel is open', account.clicked === 0)
  check('C: no interval left behind', clock.pending() === 0)
  void clock
}

// The picker's own 配置 button must not be mistaken for the menu row.
{
  const body = new El('body')
  const menu = body.append(new El('div', { 'aria-haspopup': 'menu', 'aria-label': '账号菜单' }))
  void menu
  const limbs = body.append(new El('div', { class: 'limbs-menu' }))
  const localConfig = limbs.append(new El('button', {}, '设置'))
  const account = body.append(new El('button', { 'aria-haspopup': 'menu', 'aria-label': '账号菜单' }))
  const { api } = run(block, { docRoot: body })
  const hit = api.clickSettingsMenuItem()
  check('D: picker-internal row ignored', hit === false && localConfig.clicked === 0)
  check('D: no trigger found means silent no-op', api.settingsTrigger() === account)
}

// English locale.
{
  const body = new El('body')
  const account = body.append(new El('button', { 'aria-haspopup': 'menu', 'aria-label': 'Account menu' }, 'Someone'))
  const panelHost = body.append(new El('div'))
  account.onClick = () => {
    const menu = body.append(new El('div', { role: 'menu' }))
    const settingsRow = menu.append(new El('button', {}, 'Settings'))
    settingsRow.onClick = () => {
      const panel = panelHost.append(new El('div', { 'data-shortcut-modal': 'settings' }))
      const panelNav = panel.append(new El('nav'))
      for (const label of ['General', 'Models']) panelNav.append(new El('button', {}, label))
    }
  }
  const { api, clock } = run(block, { docRoot: body, locale: 'en' })
  api.openModelsSettings()
  clock.flush(5)
  check('E: English layout B opens the panel', panelOpen(body))
  check('E: English Models section clicked', modelsCellClicked(body, 'Models'))
}

// Row label carries a trailing shortcut hint, and the text sits in a <span> —
// this is what the shipped account menu actually renders.
{
  const body = new El('body')
  const account = body.append(new El('button', { 'aria-haspopup': 'menu', 'aria-label': '账号菜单' }, 'someone'))
  const panelHost = body.append(new El('div'))
  account.onClick = () => {
    const menu = body.append(new El('div', { role: 'menu' }))
    const settingsRow = menu.append(new El('button', {}, ''))
    settingsRow.append(new El('span', {}, '设置'))
    settingsRow.append(new El('span', {}, 'Ctrl+,'))
    settingsRow.onClick = () => {
      const panel = panelHost.append(new El('div', { 'data-shortcut-modal': 'settings' }))
      const panelNav = panel.append(new El('nav'))
      for (const label of ['账号与余额', '通用设置', '模型']) panelNav.append(new El('button', {}, label))
    }
  }
  const { api, clock } = run(block, { docRoot: body })
  api.openModelsSettings()
  clock.flush(60)
  check('F: shortcut hint in row does not defeat matching', panelOpen(body))
  check('F: 模型 section still reached', modelsCellClicked(body))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
