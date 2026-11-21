// Dev scratch: list a directory inside app.asar (read-only).
import { readdirSync } from 'node:fs'

const dir = process.env.PROBE_DIR
const filter = process.env.PROBE_FILTER ? new RegExp(process.env.PROBE_FILTER) : null
let entries
try {
  entries = readdirSync(dir, { withFileTypes: true })
} catch (error) {
  console.log('readdir failed:', String(error))
  process.exit(1)
}
for (const e of entries) {
  if (filter && !filter.test(e.name)) continue
  console.log(e.isDirectory() ? 'dir  ' : 'file ', e.name)
}
