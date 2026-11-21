// Dev scratch: read a file inside app.asar with Electron's asar-aware fs (read-only).
import { readFileSync } from 'node:fs'

const target = process.env.PROBE_FILE
const patterns = String(process.env.PROBE_PATTERNS || '').split('|').filter(Boolean)
const text = readFileSync(target, 'utf8')
console.log('file:', target, 'chars:', text.length)
for (const p of patterns) {
  let i = -1
  let hits = 0
  while ((i = text.indexOf(p, i + 1)) >= 0 && hits < 8) {
    hits++
    console.log(`\n--- hit "${p}" @${i}`)
    console.log(text.slice(Math.max(0, i - 300), Math.min(text.length, i + 360)).replace(/\s+/g, ' '))
  }
  if (!hits) console.log(`\n--- no hit "${p}"`)
}
