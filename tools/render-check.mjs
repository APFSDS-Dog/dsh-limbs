#!/usr/bin/env node
/**
 * Dev-only render check for lib/client.js.
 *
 * Renders the seat component through react-dom/server with a fake
 * `ctx.modelDirectories` directory, in both the closed (trigger) and open
 * (menu) states, and prints the text the DOM would show. It does not touch the
 * running app and is not shipped.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(join(root, '.dev', 'package.json'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** Render one state of the component. */
function render({ open, metaPatch, state }) {
  let captured = null
  const noop = () => {}
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
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

  let code = source
  if (metaPatch !== undefined) {
    code = code.replace(
      /const LIMBS_META = \{[\s\S]*?\n    \}/,
      'const LIMBS_META = ' + JSON.stringify(metaPatch, null, 2),
    )
  }
  if (open) code = code.replace('const [open, setOpen] = useState(false)', 'const [open, setOpen] = useState(true)')
  // react-dom/server renders from the third (server) snapshot argument, which
  // the app never uses; point it at the fake directory so state gets rendered.
  code = code.replace(
    '\n        useCallback(() => EMPTY_STATE, []),',
    '\n        useCallback(() => (directory === null ? EMPTY_STATE : directory.getSnapshot()), [directory]),',
  )

  // eslint-disable-next-line no-new-func
  new Function(code)()

  const store = {
    getSnapshot: () => state,
    subscribe: () => noop,
    update: noop,
    set: noop,
  }
  const directory = {
    store,
    load: async () => state,
    select: async () => ({ ok: true, value: undefined }),
  }

  let registered = null
  const slots = {
    inject: (_key, callback) => { callback(); return noop },
    register: (options, component) => { registered = { options, component }; return noop },
  }
  const ctx = {
    get: (name) => {
      if (name === 'slots') return slots
      if (name === 'modelDirectories') return { directoryFor: () => directory }
      if (name === 'sessions') return { subagentAddress: () => undefined }
      return undefined
    },
    effect: (fn) => { fn(); return noop },
  }

  const plugin = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  plugin.apply(ctx)

  if (registered === null) throw new Error('seat was not registered')
  const face = registered.options.inject('session-1')
  if (face.available !== true) throw new Error('seat reported unavailable: ' + JSON.stringify(face))

  return {
    html: renderToStaticMarkup(React.createElement(registered.component, { locked: false, ...face })),
    priority: registered.options.priority,
    registrant: registered.options.registrant,
  }
}

const state = {
  current: { provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017-Event' },
  groups: [
    {
      id: 'scnet',
      name: '超算互联网scnet',
      models: [
        {
          id: 'GLM-5.3-Flash',
          name: 'GLM-5.3-Flash',
          description: 'Fast general model',
          reasoning: { efforts: [{ id: 'max', name: 'max' }], defaultEffort: 'max' },
        },
        {
          id: 'DeepSeek-V4.1-Flash-1017-Event',
          name: 'DeepSeek-V4.1-Flash-1017-Event',
          reasoning: {
            efforts: [{ id: 'off', name: 'off' }, { id: 'low', name: 'low' }, { id: 'high', name: 'high' }],
          },
        },
      ],
    },
    {
      id: 'tokenrhythm',
      name: '基元流动tokenrhythm',
      models: [
        { id: 'deepseek-v4.1-flash-1017', name: 'deepseek-v4.1-flash-1017' },
        { id: 'night-model', name: 'Night Owl', badge: { text: 'new', tone: 'info' } },
      ],
    },
  ],
  failures: [{ id: 'deepseek-account', name: 'DeepSeek 账号', message: 'not signed in' }],
  status: 'ready',
  pending: null,
  error: null,
  retainedEffort: undefined,
}

function textOf(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' | ')
}

const meta = {
  providers: { scnet: { mark: 'S' }, tokenrhythm: { mark: 'T' } },
  models: {
    'scnet/GLM-5.3-Flash': { multiplier: '0.69x', discount: '夜间折扣', status: 'idle' },
    'scnet/DeepSeek-V4.1-Flash-1017-Event': { multiplier: '0.11x', status: 'warn' },
    'tokenrhythm/night-model': { status: 'busy' },
  },
}

const closed = render({ open: false, metaPatch: meta, state })
const opened = render({ open: true, metaPatch: meta, state })

console.log('== registration')
console.log('registrant: ' + closed.registrant + ' · priority: ' + closed.priority)
console.log('== closed (trigger)')
console.log(textOf(closed.html))
console.log('== open (menu)')
console.log(textOf(opened.html).slice(0, 1600))

const checks = [
  ['priority is -1', closed.priority === -1],
  ['trigger shows current model', closed.html.includes('DeepSeek-V4.1-Flash-1017-Event')],
  ['trigger shows effort caption', closed.html.includes('提供方默认')],
  ['trigger shows provider mark', closed.html.includes('limbs-triggerMark')],
  ['search box', opened.html.includes('limbs-search')],
  ['provider tab counts', opened.html.includes('limbs-providerCount')],
  ['row status dots', opened.html.includes('limbs-dot-idle') && opened.html.includes('limbs-dot-warn') && opened.html.includes('limbs-dot-busy')],
  ['multiplier shown', opened.html.includes('0.69x') && opened.html.includes('0.11x')],
  ['discount tag', opened.html.includes('夜间折扣')],
  ['check mark on selection', opened.html.includes('✓')],
  ['failure row', opened.html.includes('not signed in')],
  ['footer counts', opened.html.includes('2 提供商') && opened.html.includes('4 模型') && opened.html.includes('1 失败')],
  ['effort chips', opened.html.includes('limbs-effortBtn')],
  ['keyboard hint', opened.html.includes('Enter')],
]
let failed = 0
console.log('== checks')
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log((ok ? 'PASS ' : 'FAIL ') + label)
}
process.exitCode = failed === 0 ? 0 : 1
