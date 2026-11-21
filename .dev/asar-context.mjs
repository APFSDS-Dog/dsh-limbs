// Dev scratch: print context windows around a pattern inside app.asar (read-only).
import { readFileSync } from 'node:fs'

const file = process.env.PROBE_FILE
const pattern = process.env.PROBE_PAT
const before = Number(process.env.PROBE_BEFORE || 400)
const after = Number(process.env.PROBE_AFTER || 700)
const max = Number(process.env.PROBE_MAX || 3)

const text = readFileSync(file, 'utf8')
let index = -1
let hits = 0
while ((index = text.indexOf(pattern, index + 1)) >= 0) {
  hits++
  const start = Math.max(0, index - before)
  console.log(`--- hit ${hits} @${index} ---`)
  console.log(text.slice(start, index + after))
  if (hits >= max) break
}
console.log('total starts scanned, hits printed:', hits)
