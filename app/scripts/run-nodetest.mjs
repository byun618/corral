// LIFE-517 — `npm test` 의 node:test 쪽. `npm test` = `vitest run` 다음에 이 스크립트.
//
// 이름 규약 (app/ 의 테스트 두 러너):
//   - vitest 파일 = `*.test.*` · `*.spec.*` (vitest 기본 include, 설정 파일 없음)
//   - node:test 파일 = `node:test` 를 import 하는 파일. 이름은 **vitest 패턴 밖**으로 짓는다(`*.nodetest.mjs` 권장)
//
// 파일 목록을 손으로 적지 않는다 — `app/` 아래에서 `node:test` 를 import 하는 파일을 **내용으로** 찾아 전부 돌린다.
// 그래서 이름을 무엇으로 짓든 새 node:test 파일이 조용히 빠지지 않는다. 대신 아래 둘은 실패로 끝낸다:
//   ① 찾은 파일이 0개 — `node --test <glob>` 은 0건이면 exit 0 으로 통과시킨다(LIFE-517 00-analysis §3 G4)
//   ② node:test 파일이 vitest 이름(`*.test.*`·`*.spec.*`)을 쓴다 — vitest 가 수집해 `No test suite found` 로 실패한다

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist'])
const SOURCE = /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/
const VITEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const IMPORTS_NODE_TEST = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]node:test['"]/

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && SOURCE.test(entry.name) ? [full] : []
  })
}

const files = walk(APP_DIR)
  .filter((file) => IMPORTS_NODE_TEST.test(fs.readFileSync(file, 'utf8')))
  .map((file) => path.relative(APP_DIR, file))
  .sort()

if (files.length === 0) {
  console.error('run-nodetest: node:test 파일을 하나도 찾지 못했다 — 0건 통과는 통과가 아니다')
  process.exit(1)
}
const misnamed = files.filter((file) => VITEST_NAME.test(file))
if (misnamed.length > 0) {
  console.error(`run-nodetest: node:test 파일이 vitest 이름을 쓴다 — *.nodetest.mjs 로 바꿀 것:\n  ${misnamed.join('\n  ')}`)
  process.exit(1)
}

console.log(`run-nodetest: node:test 파일 ${files.length}개\n  ${files.join('\n  ')}`)
const run = spawnSync(process.execPath, ['--test', ...files], { cwd: APP_DIR, stdio: 'inherit' })
process.exit(run.status ?? 1)
