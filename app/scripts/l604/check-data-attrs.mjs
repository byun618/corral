// LIFE-604 C12·C11 문서 검사 — T4 `data-*` 계측이 렌더러 소스(시험 제외)에 있는지, 만들기 렌더러 파일이 출처 이름으로 분기하지 않는지.
// 쓰기: node scripts/l604/check-data-attrs.mjs  (app/ 에서). 하나라도 어긋나면 exit 1.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../src/renderer/src')
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.|\.nodetest\./.test(entry.name)) files.push(full)
  }
}
walk(root)
const text = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]))
const ATTRS = ['data-tasks-create', 'data-inline-add', 'data-inline-add-open', 'data-quick-create', 'data-quick-create-title', 'data-quick-create-required', 'data-quick-create-submit']
let failed = 0
for (const attr of ATTRS) {
  // 속성 이름 뒤에 = 또는 따옴표 끝(정확히 그 이름)이 와야 한다 — 접두사만 같은 이름(data-inline-add-open)을 data-inline-add 로 세지 않는다.
  const pattern = new RegExp(`${attr}(?=[="'\\s])`)
  const hits = [...text].filter(([, body]) => pattern.test(body)).map(([file]) => path.relative(root, file))
  console.log(`${hits.length > 0 ? 'ok  ' : 'MISS'} ${attr} — ${hits.join(', ') || '없음'}`)
  if (hits.length === 0) failed += 1
}
const CREATE_FILES = ['quick-create-model.ts', 'hooks/useQuickCreate.ts', 'components/QuickCreate.tsx']
const BRANCH = /(jira|mock-jira|sourceId\s*===|descriptor\.name\s*===|\.id\s*===\s*'la')/i
for (const rel of CREATE_FILES) {
  const body = fs.readFileSync(path.join(root, rel), 'utf8')
  const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  const bad = BRANCH.exec(code)
  console.log(`${bad === null ? 'ok  ' : 'BAD '} 출처 이름 분기 없음 — ${rel}${bad === null ? '' : ` (${bad[0]})`}`)
  if (bad !== null) failed += 1
}
console.log(failed === 0 ? 'check-data-attrs: 통과' : `check-data-attrs: 실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
