// LIFE-604 C12·C11 문서 검사 — T4 `data-*` 계측이 렌더러 소스(시험 제외)에 있는지, 만들기 렌더러 파일이 출처 이름으로 분기하지 않는지.
// 쓰기: node scripts/l604/check-data-attrs.mjs [--extra <파일>]  (app/ 에서). 하나라도 어긋나면 exit 1.
// - `data-*` 는 **소스 문자열 존재**만 본다(주석 밖) — 렌더 확인은 단위 시험 몫이다.
// - 출처 이름 분기 검사 대상 = 기준 commit(b93ae28be) 대비 바뀐 렌더러 파일 전부(시험 제외, R1-N) + `--extra` 파일(양성 대조용).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BASE_COMMIT = 'b93ae28be'
const extraAt = process.argv.indexOf('--extra')
const extra = extraAt === -1 ? null : process.argv[extraAt + 1] ?? null
/** 주석을 뺀 코드 — `//` 줄 끝까지·`/* … *\/` 덩어리. 글자 안의 `//`(URL)은 드물어 무시한다. */
const stripComments = (body) => body.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')

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
  const hits = [...text].filter(([, body]) => pattern.test(stripComments(body))).map(([file]) => path.relative(root, file))
  console.log(`${hits.length > 0 ? 'ok  ' : 'MISS'} ${attr} — ${hits.join(', ') || '없음'}`)
  if (hits.length === 0) failed += 1
}
const appDir = path.resolve(import.meta.dirname, '../..')
const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', BASE_COMMIT, '--', 'src/renderer'], { cwd: appDir, encoding: 'utf8' })
  .split('\n').map((line) => line.replace(/^app\//, '').trim()).filter((line) => /\.(tsx|ts)$/.test(line) && !/\.test\.|\.nodetest\./.test(line))
const targets = [...changed.map((rel) => path.join(appDir, rel)), ...(extra === null ? [] : [path.resolve(extra)])]
if (changed.length === 0) { console.log('MISS 바뀐 렌더러 파일을 못 찾음 — 검사 대상 0'); failed += 1 }
const BRANCH = /(jira|mock-jira|sourceId\s*[!=]==|descriptor\.name\s*[!=]==|\.id\s*[!=]==\s*'la'|'la'\s*[!=]==)/i
for (const file of targets) {
  const bad = BRANCH.exec(stripComments(fs.readFileSync(file, 'utf8')))
  console.log(`${bad === null ? 'ok  ' : 'BAD '} 출처 이름 분기 없음 — ${path.relative(appDir, file)}${bad === null ? '' : ` (${bad[0]})`}`)
  if (bad !== null) failed += 1
}
console.log(failed === 0 ? 'check-data-attrs: 통과' : `check-data-attrs: 실패 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
