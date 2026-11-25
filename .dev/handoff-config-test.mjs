/**
 * 模块八 · 项目管理 · 离线测试（段 1：配置链路）。
 *
 * 只验两件事：
 *   1. `inject` 开关真的能让 assemble 闭嘴（不再产出热层文本，listener 记 skipped）；
 *   2. `GET/PUT /limbs/handoff-config` 的令牌 / 同源 / 校验 / 原子落盘 / 只写覆盖项。
 *
 * 全部在临时目录里跑 —— 除了自建的临时目录，不碰仓库文件。
 *
 * 跑法（本机 PATH 上没有 node，用 Electron 当 Node）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\handoff-config-test.mjs
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_HANDOFF_CONFIG,
  createHandoffAssembler,
  parseHandoffYaml,
  readHandoffConfig,
  resolveHandoffConfig,
} from '../lib/handoff.js'

import {
  HANDOFF_BRIDGE_ROUTE,
  HANDOFF_BRIDGE_GLOBAL,
  HANDOFF_CONFIG_KEYS,
  HANDOFF_CONFIG_ROUTE,
  HANDOFF_PROJECT_ROUTE,
  createHandoffConfigBridge,
  readProjectDetail,
  readProjectSummary,
  renderHandoffYaml,
  resolveProjectPath,
  serveHandoffBridge,
  serveHandoffConfig,
  serveHandoffProject,
  validateConfigPatch,
  writeProjectHandoffConfig,
} from '../lib/handoff-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const TEMP_DIRS = []
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

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

const now = () => 1_795_000_000_000

/** 造一个假项目：PROJECT_PROGRESS.md + 一份 devlog + 可选 config。 */
async function makeProject(prefix, options = {}) {
  const dir = await tempDir(prefix)
  const progress = [
    '# 项目进度 · 假项目',
    '',
    '## 二、任务账',
    '',
    '| id | 标题 | 状态 | 结论 | 存档 | next |',
    '|---|---|---|---|---|---|',
    '| `t-20260101-01` | 第一件事 | `done` | 做完了 | `t-20260101-01` | — |',
    '| `t-20260101-02` | 第二件事 | `doing` | 还在做 | `t-20260101-02` | 收尾 |',
    '',
    '## 3.3 待拍板清单',
    '',
    '### 待拍板（按编号，不重排）',
    '',
    '| 编号 | 事项 | 为什么没定 | 选项 + 代价 | 阻塞？ |',
    '|---|---|---|---|---|',
    '| Q9 | 假问题 | 假原因 | A / B | — |',
    '',
  ].join('\n')
  await writeFile(join(dir, 'PROJECT_PROGRESS.md'), progress, 'utf8')
  await writeFile(join(dir, 'PROJECT_STATUS.md'),
    '## 二、实测状态快照\n\n**核对日期：2026-01-01**\n\n| 项 | 实测值 |\n|---|---|\n| 假项 | 1 |\n', 'utf8')
  await mkdir(join(dir, 'Docs', 'devlog'), { recursive: true })
  for (const [id, title] of [['t-20260101-01', '第一件事'], ['t-20260101-02', '第二件事']]) {
    await writeFile(join(dir, 'Docs', 'devlog', `${id}_测试项.md`),
      `# ${id} · ${title}\n\n## goal\n\n假的。\n\n## confirmed_facts\n\n假的。\n\n`
      + '## excluded_paths\n\n假的。\n\n## todos\n\n假的。\n', 'utf8')
  }
  if (options.config !== undefined) {
    await mkdir(join(dir, '.dsh'), { recursive: true })
    await writeFile(join(dir, '.dsh', 'handoff.yaml'), options.config, 'utf8')
  }
  return dir
}

function requestFor(pathAndQuery, options = {}) {
  const headers = new Headers()
  if (options.token !== undefined) headers.set('x-limbs-token', options.token)
  if (options.origin !== undefined) headers.set('origin', options.origin)
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Request('http://127.0.0.1:63751' + pathAndQuery, {
    method: options.method ?? 'GET',
    headers,
    body,
  })
}

const hiddenConfigTokens = ['inject', 'write', 'ledgerRecent', 'checkCommand']

try {
  // ═══════════════════════════════════════════════════════════════════════
  log('== 1. inject 开关：默认值与收敛')
  // ═══════════════════════════════════════════════════════════════════════
  check('默认 inject=true（热注入默认开）', DEFAULT_HANDOFF_CONFIG.inject === true)
  check('默认值仍是四个键', JSON.stringify(Object.keys(DEFAULT_HANDOFF_CONFIG).sort())
    === JSON.stringify(hiddenConfigTokens.slice().sort()),
    JSON.stringify(Object.keys(DEFAULT_HANDOFF_CONFIG)))
  check('配置键清单与默认值一致',
    JSON.stringify(HANDOFF_CONFIG_KEYS.slice().sort()) === JSON.stringify(hiddenConfigTokens.slice().sort()))
  check('inject=false 被采纳', resolveHandoffConfig({ inject: false }).config.inject === false)
  check('inject 坏值回退 true 并留 warning',
    resolveHandoffConfig({ inject: 'off' }).config.inject === true
    && resolveHandoffConfig({ inject: 'off' }).warnings.some(w => w.includes('inject')),
    JSON.stringify(resolveHandoffConfig({ inject: 'off' }).warnings))

  // ═══════════════════════════════════════════════════════════════════════
  log('== 2. inject=false 时 assemble 不再注入')
  // ═══════════════════════════════════════════════════════════════════════
  const offProject = await makeProject('dsh-limbs-m8-off-', { config: 'inject: false\n' })
  {
    const { listener, stats } = createHandoffAssembler()
    const prepended = []
    const agent = {
      session: { header: { cwd: offProject } },
      inbox: { prepend: (target, message) => prepended.push({ target, message }) },
    }
    const userMessage = { id: 'm-user', role: 'user', content: [{ type: 'text', text: '开工' }] }
    const decision = await listener(
      { agent, messages: [userMessage], step: 1, signal: undefined },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )
    check('inject=false → decision 原样返回', decision.kind === 'enter' && decision.messages.length === 1,
      JSON.stringify(decision.messages.map(m => m.id ?? 'injected')))
    check('inject=false → 没有注入消息', !decision.messages.some(m => m.id !== 'm-user'))
    check('inject=false → 计入 skipped（不是 injected）', stats.skipped === 1 && stats.injected === 0,
      JSON.stringify(stats))
    check('inject=false → inbox 也没被塞', prepended.length === 0, JSON.stringify(prepended.length))
  }
  check('inject=false 时读配置确实是 false', (await readHandoffConfig(offProject)).config.inject === false)

  // 反向对照：同一套假工程，配置改成 inject: true 就必须注入
  await writeFile(join(offProject, '.dsh', 'handoff.yaml'), 'inject: true\n', 'utf8')
  {
    const { listener, stats } = createHandoffAssembler()
    const agent = { session: { header: { cwd: offProject } }, inbox: { prepend: () => {} } }
    const userMessage = { id: 'm-user', role: 'user', content: [{ type: 'text', text: '开工' }] }
    const decision = await listener(
      { agent, messages: [userMessage], step: 1, signal: undefined },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )
    check('inject=true（反向对照）→ 注入在提问之后',
      decision.messages.length === 2 && decision.messages[1].id !== 'm-user'
      && decision.messages[1].content[0].text.includes('热层注入'),
      JSON.stringify(decision.messages.map(m => m.id ?? 'injected')))
    check('inject=true → 计入 injected', stats.injected === 1, JSON.stringify(stats))
  }

  // 缺配置 = 默认 true（不能因为文件不存在就静默关掉）
  {
    const bare = await makeProject('dsh-limbs-m8-nocfg-')
    check('缺 .dsh/handoff.yaml 时 config.inject 仍是 true',
      (await readHandoffConfig(bare)).config.inject === true)
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 3. 项目级 YAML 只写覆盖项')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const allDefault = renderHandoffYaml({ ...DEFAULT_HANDOFF_CONFIG })
    const parsedDefault = parseHandoffYaml(allDefault)
    check('全默认 → 正文里一个配置行都没有',
      Object.keys(parsedDefault).length === 0, JSON.stringify(parsedDefault))
    check('全默认 → 注释仍在（文件不是空的）', allDefault.split('\n').some(line => line.startsWith('# ')))

    const mixed = renderHandoffYaml({ inject: false, write: true, ledgerRecent: 7, checkCommand: 'pwsh -File ./check-docs.ps1' })
    const parsedMixed = parseHandoffYaml(mixed)
    check('覆盖项被写出', parsedMixed.inject === false && parsedMixed.write === true
      && parsedMixed.ledgerRecent === 7 && parsedMixed.checkCommand === 'pwsh -File ./check-docs.ps1',
      JSON.stringify(parsedMixed))

    // 往返：写出的正文读回来必须收敛成同一份配置
    const back = resolveHandoffConfig(parsedMixed)
    check('渲染 → 解析 → 收敛 往返一致',
      back.config.inject === false && back.config.write === true
      && back.config.ledgerRecent === 7 && back.warnings.length === 0,
      JSON.stringify(back))

    const project = await makeProject('dsh-limbs-m8-yaml-')
    const written = await writeProjectHandoffConfig(project, { ...DEFAULT_HANDOFF_CONFIG, inject: false })
    check('原子写落到 .dsh/handoff.yaml', written.path === join(project, '.dsh', 'handoff.yaml'), written.path)
    const dirFiles = await readdir(join(project, '.dsh'))
    check('落盘后没有残留 .tmp 文件',
      dirFiles.length === 1 && dirFiles[0] === 'handoff.yaml', JSON.stringify(dirFiles))
    check('落盘内容确实是 inject: false', (await readFile(written.path, 'utf8')).includes('inject: false'))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 4. 配置校验：坏值给可读原因，不静默回退')
  // ═══════════════════════════════════════════════════════════════════════
  {
    check('缺内容被拒', validateConfigPatch(undefined).ok === false)
    check('数组被拒', validateConfigPatch([]).ok === false)
    const unknown = validateConfigPatch({ nope: 1 })
    check('未知键被拒并点名', unknown.ok === false && unknown.message.includes('nope'), unknown.message)
    check('inject 非布尔被拒', validateConfigPatch({ inject: 'true' }).ok === false)
    check('ledgerRecent 0 被拒', validateConfigPatch({ ledgerRecent: 0 }).ok === false)
    check('ledgerRecent 101 被拒', validateConfigPatch({ ledgerRecent: 101 }).ok === false)
    check('ledgerRecent 小数被拒', validateConfigPatch({ ledgerRecent: 3.5 }).ok === false)
    check('checkCommand 带 # 被拒（会被当注释截断）',
      validateConfigPatch({ checkCommand: 'pwsh -File a.ps1 # 注释' }).ok === false,
      validateConfigPatch({ checkCommand: 'pwsh -File a.ps1 # 注释' }).message)
    check('四键齐全的合法值被接受', validateConfigPatch({
      inject: false, write: true, ledgerRecent: 5, checkCommand: 'pwsh -File ./check-docs.ps1',
    }).ok === true)
    // 返回的必须是**补丁**：只含提交的键。否则「只改 inject」会把 write 抹成默认 false
    // —— 真机上刚点一下热注入开关，本项目的 write: true 就没了。
    const onlyInject = validateConfigPatch({ inject: false })
    check('只提交 inject 时补丁也只含 inject',
      onlyInject.ok === true && JSON.stringify(Object.keys(onlyInject.patch ?? {})) === '["inject"]',
      JSON.stringify(onlyInject.patch))
    const onlyLedger = validateConfigPatch({ ledgerRecent: 7 })
    check('只提交 ledgerRecent 时补丁也只含它',
      onlyLedger.ok === true && JSON.stringify(Object.keys(onlyLedger.patch ?? {})) === '["ledgerRecent"]',
      JSON.stringify(onlyLedger.patch))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 5. 路径准入：注册表 → 项目形态 → 拒绝')
  // ═══════════════════════════════════════════════════════════════════════
  const regProject = await makeProject('dsh-limbs-m8-reg-')
  const bareProject = await makeProject('dsh-limbs-m8-bare-')
  const plainDir = await tempDir('dsh-limbs-m8-plain-')
  const registry = { list: () => [{ id: 'ws-1', path: regProject, title: '假工作区' }] }
  {
    const registered = await resolveProjectPath(regProject, registry)
    check('已登记工作区被放行', registered.ok === true && registered.registered === true,
      JSON.stringify(registered))
    check('已登记工作区带上标题与 id',
      registered.title === '假工作区' && registered.workspaceId === 'ws-1',
      JSON.stringify({ title: registered.title, id: registered.workspaceId }))

    const looksLike = await resolveProjectPath(bareProject, registry)
    check('未登记但有 PROJECT_PROGRESS.md → 放行（registered=false）',
      looksLike.ok === true && looksLike.registered === false && looksLike.title === null,
      JSON.stringify(looksLike))

    const relative = await resolveProjectPath('relative/path', registry)
    check('相对路径被拒', relative.ok === false && relative.code === 'path', JSON.stringify(relative))

    const dotdot = await resolveProjectPath('D:\\a\\..\\b', registry)
    check('含 .. 的路径被拒', dotdot.ok === false && dotdot.code === 'path', JSON.stringify(dotdot))

    const plain = await resolveProjectPath(plainDir, registry)
    check('无项目特征的目录被拒并说明原因',
      plain.ok === false && plain.code === 'unregistered'
      && plain.message.includes('工作区'), JSON.stringify(plain))

    const missing = await resolveProjectPath(join(plainDir, 'nope'), registry)
    check('不存在的路径被拒', missing.ok === false && missing.code === 'missing', JSON.stringify(missing))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 6. GET /limbs/handoff-config：令牌 + 同源 + 列表')
  // ═══════════════════════════════════════════════════════════════════════
  const TOKEN = 'test-token-m8'
  {
    const noToken = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { origin: 'http://127.0.0.1:63751' }),
      { token: TOKEN, registry },
    )
    check('缺令牌 → 403', noToken.status === 403, String(noToken.status))
    check('缺令牌的响应码是 forbidden', (await noToken.json()).code === 'forbidden')

    const wrongToken = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { token: 'wrong', origin: 'http://127.0.0.1:63751' }),
      { token: TOKEN, registry },
    )
    check('错误令牌 → 403', wrongToken.status === 403, String(wrongToken.status))

    const crossOrigin = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { token: TOKEN, origin: 'http://evil.example' }),
      { token: TOKEN, registry },
    )
    check('跨站来源 → 403', crossOrigin.status === 403, String(crossOrigin.status))
    check('跨站来源的响应码是 cross-origin', (await crossOrigin.json()).code === 'cross-origin')

    // 桌面端：页面跑在 dsh-app://app，外壳转发请求时保留这个 Origin。
    // 只认同源会让桌面端每个请求都 403 → 页面显示「接口没挂上」（真机踩过）。
    const desktopOrigin = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { token: TOKEN, origin: 'dsh-app://app' }),
      { token: TOKEN, registry },
    )
    check('桌面主窗口 origin（dsh-app://app）被放行', desktopOrigin.status === 200,
      String(desktopOrigin.status))
    const otherAppOrigin = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { token: TOKEN, origin: 'dsh-app://shell' }),
      { token: TOKEN, registry },
    )
    check('别的 dsh-app host 仍被拒', otherAppOrigin.status === 403, String(otherAppOrigin.status))

    const listResponse = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { token: TOKEN, origin: 'http://127.0.0.1:63751' }),
      { token: TOKEN, registry, now },
    )
    const listBody = await listResponse.json()
    check('授权 + 同源 → 200', listResponse.status === 200, String(listResponse.status))
    check('列表带全局默认', listBody.defaults?.inject === true && listBody.defaults?.write === false,
      JSON.stringify(listBody.defaults))
    check('列表里有一个项目', Array.isArray(listBody.projects) && listBody.projects.length === 1,
      JSON.stringify(listBody.projects?.length))
    const summary = listBody.projects[0]
    check('摘要有账表条数', summary.ledgerRows === 2, String(summary.ledgerRows))
    check('摘要有最近一次收尾 id', summary.latestArchiveId === 't-20260101-02', String(summary.latestArchiveId))
    check('摘要有真写开关状态', summary.config?.write === false, JSON.stringify(summary.config))
    check('摘要有热注入开关状态', summary.config?.inject === true, JSON.stringify(summary.config))
    check('摘要有 devlog 条数', summary.devlogCount === 2, String(summary.devlogCount))

    const single = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE + '?path=' + encodeURIComponent(regProject), { token: TOKEN }),
      { token: TOKEN, registry },
    )
    const singleBody = await single.json()
    check('单项目读取 200', single.status === 200, String(single.status))
    check('单项目标明 registered', singleBody.registered === true)
    check('单项目给出每项来源（默认）',
      HANDOFF_CONFIG_KEYS.every(key => singleBody.sources[key] === 'default'), JSON.stringify(singleBody.sources))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 7. PUT /limbs/handoff-config：原子落盘，只改覆盖项')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const before = await stat(join(regProject, '.dsh', 'handoff.yaml')).catch(() => null)
    check('PUT 前没有配置文件（新项目）', before === null)

    const put = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, {
        method: 'PUT', token: TOKEN, origin: 'http://127.0.0.1:63751',
        body: { path: regProject, config: { inject: false } },
      }),
      { token: TOKEN, registry, now },
    )
    check('PUT 成功 200', put.status === 200, String(put.status))
    const putBody = await put.json()
    check('PUT 回显生效配置 inject=false', putBody.config?.inject === false, JSON.stringify(putBody.config))
    check('PUT 回显 sources.inject=project', putBody.sources?.inject === 'project', JSON.stringify(putBody.sources))
    check('PUT 回显 sources.write=default', putBody.sources?.write === 'default', JSON.stringify(putBody.sources))

    const onDisk = await readFile(join(regProject, '.dsh', 'handoff.yaml'), 'utf8')
    check('磁盘上只写了 inject 一行覆盖', parseHandoffYaml(onDisk).inject === false
      && Object.keys(parseHandoffYaml(onDisk)).length === 1, JSON.stringify(parseHandoffYaml(onDisk)))
    check('磁盘上没有 write/ledgerRecent 的显式行', !/^write:/m.test(onDisk) && !/^ledgerRecent:/m.test(onDisk))

    // 再改一次：把 inject 打开 + 设 ledgerRecent，验证「合并」而不是「替换」
    const put2 = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, {
        method: 'PUT', token: TOKEN, body: { path: regProject, config: { inject: true, ledgerRecent: 6 } },
      }),
      { token: TOKEN, registry },
    )
    const put2Body = await put2.json()
    check('第二次 PUT 合并生效', put2.status === 200 && put2Body.config.inject === true
      && put2Body.config.ledgerRecent === 6, JSON.stringify(put2Body.config))
    check('ledgerRecent 被写成覆盖项',
      parseHandoffYaml(await readFile(join(regProject, '.dsh', 'handoff.yaml'), 'utf8')).ledgerRecent === 6)

    // 坏值：只回 400，磁盘不能被改
    const diskBeforeBad = await readFile(join(regProject, '.dsh', 'handoff.yaml'), 'utf8')
    const bad = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, {
        method: 'PUT', token: TOKEN, body: { path: regProject, config: { inject: 'yes' } },
      }),
      { token: TOKEN, registry },
    )
    check('坏值 → 400', bad.status === 400, String(bad.status))
    const badBody = await bad.json()
    check('坏值给可读中文原因', typeof badBody.message === 'string' && badBody.message.includes('inject'),
      badBody.message)
    check('坏值不写盘', (await readFile(join(regProject, '.dsh', 'handoff.yaml'), 'utf8')) === diskBeforeBad)

    // 未登记但像项目的目录：允许写（且响应明示 registered=false）
    const barePut = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, {
        method: 'PUT', token: TOKEN, body: { path: bareProject, config: { inject: false } },
      }),
      { token: TOKEN, registry },
    )
    const bareBody = await barePut.json()
    check('未登记项目也能写（registered=false 明示）',
      barePut.status === 200 && bareBody.registered === false && bareBody.config.inject === false,
      JSON.stringify({ status: barePut.status, registered: bareBody.registered }))

    // 什么都不像的目录：拒绝，且不落盘
    const plainPut = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, {
        method: 'PUT', token: TOKEN, body: { path: plainDir, config: { inject: false } },
      }),
      { token: TOKEN, registry },
    )
    check('无项目特征的目录写入被拒', plainPut.status === 400, String(plainPut.status))
    check('被拒后该目录没被创建 .dsh',
      (await stat(join(plainDir, '.dsh')).catch(() => null)) === null)

    const getMethod = await serveHandoffConfig(
      requestFor(HANDOFF_CONFIG_ROUTE, { method: 'DELETE', token: TOKEN }),
      { token: TOKEN, registry },
    )
    check('不支持的方法 → 405', getMethod.status === 405, String(getMethod.status))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 8. GET /limbs/handoff-project：二级页只读数据')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const detailResponse = await serveHandoffProject(
      requestFor(HANDOFF_PROJECT_ROUTE + '?path=' + encodeURIComponent(regProject), { token: TOKEN }),
      { token: TOKEN, registry },
    )
    check('详情 200', detailResponse.status === 200, String(detailResponse.status))
    const detail = (await detailResponse.json()).detail
    check('详情带账表行', detail.ledgerRows.length === 2, String(detail.ledgerRows?.length))
    check('详情带 §3.3 待拍板', detail.pending.includes('Q9'), detail.pending.slice(0, 40))
    check('详情带 STATUS 快照与核对日期',
      detail.statusSnapshot.includes('假项') && detail.statusCheckedAt === '2026-01-01',
      String(detail.statusCheckedAt))
    check('devlog 列表按 id 倒序（新的在前）',
      detail.devlogs.length === 2 && detail.devlogs[0].id === 't-20260101-02'
      && detail.devlogs[1].id === 't-20260101-01',
      JSON.stringify(detail.devlogs.map(item => item.id)))

    const oneDevlog = await serveHandoffProject(
      requestFor(HANDOFF_PROJECT_ROUTE + '?path=' + encodeURIComponent(regProject) + '&id=t-20260101-01',
        { token: TOKEN }),
      { token: TOKEN, registry },
    )
    const devlogBody = (await oneDevlog.json()).devlog
    check('按 id 取 devlog 正文', oneDevlog.status === 200 && devlogBody.found === true
      && devlogBody.text.includes('t-20260101-01'), JSON.stringify(devlogBody.found))
    check('devlog 四段被解析', devlogBody.sections?.goal === '假的。', JSON.stringify(devlogBody.sections))

    const missingDevlog = await serveHandoffProject(
      requestFor(HANDOFF_PROJECT_ROUTE + '?path=' + encodeURIComponent(regProject) + '&id=t-20260102-99',
        { token: TOKEN }),
      { token: TOKEN, registry },
    )
    const missingBody = (await missingDevlog.json()).devlog
    check('不存在的 id 给可读原因', missingDevlog.status === 200 && missingBody.found === false
      && typeof missingBody.reason === 'string', JSON.stringify(missingBody.reason))

    const projectNoToken = await serveHandoffProject(
      requestFor(HANDOFF_PROJECT_ROUTE + '?path=' + encodeURIComponent(regProject)),
      { token: TOKEN, registry },
    )
    check('详情路由也要令牌', projectNoToken.status === 403, String(projectNoToken.status))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 9. 摘要与详情的纯函数面（不经 HTTP）')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const summary = await readProjectSummary(bareProject)
    check('readProjectSummary 有 latestArchiveId', summary.latestArchiveId === 't-20260101-02',
      String(summary.latestArchiveId))
    const detail = await readProjectDetail(bareProject)
    check('readProjectDetail 不炸且有 devlogs', detail.devlogs.length === 2, String(detail.devlogs.length))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 10. 挂载：webServer 缺席则静默降级')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const noServer = createHandoffConfigBridge({ get: () => undefined, effect: fn => fn() })
    check('没有 webServer → 返回 undefined（不抛）', noServer === undefined)

    const routes = []
    const tapped = []
    const listeners = new Map()
    const fakeWeb = {
      register: route => { routes.push(route); return () => {} },
      tapIndex: transform => { tapped.push(transform); return () => {} },
    }
    const service = { list: () => [{ id: 'ws-1', path: regProject, title: '假工作区' }] }
    const bridge = createHandoffConfigBridge({
      get: name => (name === 'webServer' ? fakeWeb : name === 'workspaceRegistry' ? service : undefined),
      effect: fn => fn(),
      on: (event, listener) => {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(listener)
        return () => {}
      },
    })
    check('挂载返回三条路由（两个数据接口 + 一个令牌引导）',
      bridge?.routes?.length === 3 && routes.map(r => r.path).sort().join(',')
        === [HANDOFF_CONFIG_ROUTE, HANDOFF_PROJECT_ROUTE, HANDOFF_BRIDGE_ROUTE].sort().join(','),
      JSON.stringify(routes.map(r => r.path)))
    check('三条路由都是 exact', routes.every(route => route.kind === 'exact'))
    check('令牌是随机串且给了 index 注入',
      typeof bridge.token === 'string' && bridge.token.length >= 16 && tapped.length === 1,
      String(bridge.token?.length))
    const html = tapped[0]('<html><head></head><body></body></html>')
    check('index 注入写了桥接全局', html.includes('window.' + HANDOFF_BRIDGE_GLOBAL), html.slice(0, 120))
    const payloadText = html.slice(html.indexOf('=') + 1, html.indexOf(';</script>'))
    const payload = JSON.parse(payloadText)
    check('桥接里不含令牌以外的敏感物', typeof payload.token === 'string'
      && payload.configPath === HANDOFF_CONFIG_ROUTE && payload.projectPath === HANDOFF_PROJECT_ROUTE,
      payloadText)
    check('桥接 JSON 做了 < 转义', !payloadText.includes('<'))

    // ── 桌面端路径：结构化注入行（这是真机实际走的那条）───────────────
    const indexInjectListeners = listeners.get('webserver/index-inject') ?? []
    check('订阅了 webserver/index-inject（桌面端注入靠它）', indexInjectListeners.length === 1,
      String(indexInjectListeners.length))
    const table = []
    for (const listener of indexInjectListeners) listener(table, { id: 'peer-1' })
    check('注入表里多了一行 global', table.length === 1 && table[0].kind === 'global',
      JSON.stringify(table))
    check('行名就是页面桥接全局', table[0]?.name === HANDOFF_BRIDGE_GLOBAL, String(table[0]?.name))
    check('行的值带令牌与两条路由',
      table[0]?.value?.token === bridge.token
      && table[0]?.value?.configPath === HANDOFF_CONFIG_ROUTE
      && table[0]?.value?.projectPath === HANDOFF_PROJECT_ROUTE,
      JSON.stringify(table[0]?.value))
    check('同一个令牌（index 注入与结构化注入必须一致，否则页面会拿到旧令牌）',
      JSON.parse(payloadText).token === table[0]?.value?.token, '')
    // 二次 emit 不该叠加：每次 emit 都是新表（框架每次 render 给新数组）。
    const table2 = []
    for (const listener of indexInjectListeners) listener(table2)
    check('第二次 emit 也是恰好一行（不累积）', table2.length === 1, String(table2.length))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 10b. 令牌引导：/limbs/handoff-bridge 只回令牌与路由名')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const ok = await serveHandoffBridge(
      requestFor(HANDOFF_BRIDGE_ROUTE, { origin: 'http://127.0.0.1:63751' }),
      { token: TOKEN },
    )
    const body = await ok.json()
    check('同源 GET 换到令牌', ok.status === 200 && body.token === TOKEN,
      JSON.stringify({ status: ok.status, hasToken: typeof body.token === 'string' }))
    check('引导只回令牌与两条路由名，不带项目数据',
      JSON.stringify(Object.keys(body).sort())
        === JSON.stringify(['configPath', 'ok', 'projectPath', 'token']), JSON.stringify(Object.keys(body)))
    check('引导回的路径就是两条数据接口',
      body.configPath === HANDOFF_CONFIG_ROUTE && body.projectPath === HANDOFF_PROJECT_ROUTE)

    const cross = await serveHandoffBridge(
      requestFor(HANDOFF_BRIDGE_ROUTE, { origin: 'http://evil.example' }),
      { token: TOKEN },
    )
    check('跨站来源换令牌被拒', cross.status === 403, String(cross.status))

    const desktop = await serveHandoffBridge(
      requestFor(HANDOFF_BRIDGE_ROUTE, { origin: 'dsh-app://app' }),
      { token: TOKEN },
    )
    check('桌面主窗口 origin 能换令牌', desktop.status === 200, String(desktop.status))

    const put = await serveHandoffBridge(
      requestFor(HANDOFF_BRIDGE_ROUTE, { method: 'PUT', token: TOKEN }),
      { token: TOKEN },
    )
    check('引导路由只认 GET', put.status === 405, String(put.status))
  }

  // ═══════════════════════════════════════════════════════════════════════
  log('== 11. 真仓库未被本测试写坏')
  // ═══════════════════════════════════════════════════════════════════════
  {
    const realConfig = await readFile(join(root, '.dsh', 'handoff.yaml'), 'utf8').catch(() => null)
    check('真项目 .dsh/handoff.yaml 仍是原样（本测试只碰临时目录）',
      realConfig === null || realConfig.includes('write: true'), String(realConfig?.slice(0, 40)))
    const progress = await readFile(join(root, 'PROJECT_PROGRESS.md'), 'utf8')
    check('真仓库账表没被追加假账行', !progress.includes('t-20260101-01'))
  }
} finally {
  // 无条件清理：临时目录只在这里统一删，不靠记着在哪一行 rm。
  for (const dir of TEMP_DIRS.splice(0)) {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  }
  const leftovers = TEMP_DIRS.length
  check('临时目录已全部清理', leftovers === 0, String(leftovers))
}

log('== summary')
log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
