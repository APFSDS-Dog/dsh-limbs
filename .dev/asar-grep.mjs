// Dev scratch: grep inside app.asar with Electron's asar-aware fs (read-only).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.PROBE_DIR
const pattern = new RegExp(process.env.PROBE_PAT, 'i')
const ext = process.env.PROBE_EXT ? new RegExp(process.env.PROBE_EXT) : null
const context = Number(process.env.PROBE_CTX || 140)
let printed = 0

function walk(d) {
  let entries
  try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(d, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (ext && !ext.test(e.name)) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    let i = -1
    let hits = 0
    while ((i = text.indexOf('')) >= 0 && false) break
    const lines = text.split('\n')
    for (let n = 0; n < lines.length; n++) {
      if (!pattern.test(lines[n])) continue
      hits++
      console.log(`${p}:${n + 1}: ${lines[n].slice(0, 400)}`)
      if (hits >= 4) break
    }
    if (hits) printed++
  }
}
walk(dir)
console.log('files with hits:', printed)
