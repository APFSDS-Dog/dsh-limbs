/**
 * 真机路径冒烟（只读 + 一次写删）：不启动 DSH，用**本机真实的 DSH_HOME**
 * 验证 `<DSH_HOME>/dsh-limbs/reviews/` 这个落点真的可写、读回一致、清理生效，
 * 验完把临时文件删掉，不留痕迹。
 *
 * 为什么值得单独跑：离线测试用的是假 ctx + 临时目录，`dshHomePath` 与
 * `DSH_HOME` 两条真实分支都没被碰过。这里走 env 回退分支 + 真实磁盘。
 *
 * 跑法：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Apps\DeepSeekHarness\DeepSeek Harness.exe' .dev\review-home-smoke.mjs
 */
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { REVIEW_KEEP_COUNT, readReviewReport, reviewsDir, saveReviewReport } from '../lib/review-store.js'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 没有 dshHomePath 服务的 ctx → 走 `process.env.DSH_HOME` 回退分支（真实路径）
const ctx = { get: () => undefined }
const dir = reviewsDir(ctx)
console.log(`  真实落点：${dir}`)
check('落点就在本机 DSH_HOME 下', process.env.DSH_HOME !== undefined
  && dir.startsWith(process.env.DSH_HOME), dir)

const MARK = `smoke-${process.pid}-${Date.now()}`
const sessionId = `session:smoke-${MARK}`
const body = `# 冒烟报告 ${MARK}\n\n这条在冒烟结束后会被删掉。\n`

const saved = await saveReviewReport(ctx, sessionId, body)
check('真实目录可写（文件已生成）', existsSync(saved.path), saved.path)
check('生成时间是真实 mtime', Number.isFinite(saved.generatedAt) && saved.generatedAt > 0,
  String(saved.generatedAt))

const back = await readReviewReport(ctx, sessionId)
check('真实路径读回一致', back.found === true && back.markdown === body, JSON.stringify(back.markdown?.slice(0, 20)))

const info = await stat(saved.path)
check('文件落在 reviews 目录里', saved.path.startsWith(join(process.env.DSH_HOME, 'dsh-limbs', 'reviews')),
  saved.path)

// 目录里现在有几份（真机上这次复盘之外可能还有别的，只报数，不断言）
const names = await readdir(dir)
console.log(`  目录现有 ${names.length} 份报告（清理上限 ${REVIEW_KEEP_COUNT}）`)

// 收尾：把冒烟文件删掉，别留垃圾
await rm(saved.path, { force: true })
check('冒烟文件已清理（没在真机目录留垃圾）', !existsSync(saved.path))

console.log(`\n${'='.repeat(52)}\n结果：PASS ${passed} / FAIL ${failed} / 共 ${passed + failed}`)
if (failed > 0) process.exitCode = 1
