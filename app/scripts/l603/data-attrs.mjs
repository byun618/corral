// LIFE-603 C16 보조 — design-handoff §계측의 T5 data-* 가 렌더러 소스에 있는지(정적 검사). 화면 실측(격리 앱 CDP)은 최종 관문.
// 사용: node scripts/l603/data-attrs.mjs  → 없으면 종료 1.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ATTRS = [
  'data-issue-worktree', 'data-issue-open', 'data-issue-start', 'data-issue-work',
  'data-start-work', 'data-start-existing', 'data-start-name', 'data-start-prompt', 'data-start-progress', 'data-start-submit',
  'data-worktree-issue',
]
const root = new URL('../../src/renderer/src/', import.meta.url).pathname
const files = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(path) } }
walk(root)
const text = files.map((path) => readFileSync(path, 'utf8')).join('\n')
const rows = ATTRS.map((attr) => ({ attr, found: new RegExp(`${attr}[=\\s"{]`).test(text) }))
for (const row of rows) console.log(`${row.found ? 'ok  ' : 'MISS'} ${row.attr}`)
const missing = rows.filter((row) => !row.found)
console.log(`${rows.length - missing.length}/${rows.length}`)
process.exit(missing.length === 0 ? 0 : 1)
