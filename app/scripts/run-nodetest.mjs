// LIFE-517 — `npm test` 의 node:test 쪽. `npm test` = `vitest run` 다음에 이 스크립트.
//
// 이름 규약 (app/ 의 테스트 두 러너):
//   - vitest 파일 = `*.test.*` · `*.spec.*` (vitest 기본 include, 설정 파일 없음)
//   - node:test 파일 = `node:test` 를 import 하는 파일. 이름은 **vitest 패턴 밖**으로 짓는다(`*.nodetest.mjs` 권장)
// 한 파일만: `npx vitest run <파일>` · `node --test <파일>`. `npm test -- <필터>` 는 vitest 에 닿지 않는다(`&&` 앞 명령이라).
//
// 파일 목록을 손으로 적지 않는다 — `app/` 아래에서 `node:test` 를 import 하는 파일을 **내용으로** 찾아 전부 돌린다.
// 그래서 이름을 무엇으로 짓든 새 node:test 파일이 조용히 빠지지 않는다. 대신 아래 둘은 실패로 끝낸다:
//   ① 찾은 파일이 0개 — `node --test <glob>` 은 0건이면 exit 0 으로 통과시킨다(LIFE-517 00-analysis §3 G4)
//   ② node:test 파일이 vitest 이름(`*.test.*`·`*.spec.*`)을 쓴다 — vitest 가 수집해 `No test suite found` 로 실패한다
//
// 탐색 범위: 점 폴더·점 파일도 본다. 빼는 것은 남의 코드·산출물·VCS 뿐이다 — `node_modules`(의존성),
// `out`·`dist`(빌드 산출물, eslint ignores 와 같다), `.git`(VCS 내부). 확장자는 vitest include 와 같은 `[cm]?[jt]sx?`.
// 이 러너 자신도 뺀다 — 아래 주석에 탐색 대상 문구가 있어, 빼지 않으면 자기를 다시 띄워 무한 재귀한다.
// 실행: 파일마다 `node <파일>` 로 따로 띄운다(node:test 는 그 파일의 테스트를 돌리고 실패면 exit 1).
// `node --test <경로>` 는 경로를 글롭으로 읽어 `[1]`·`*` 가 든 경로를 조용히 놓친다(LIFE-517 r1 R1-claude-01) — 그래서 쓰지 않는다.
// 탐색 한계: import 를 정규식으로 본다. 주석·문자열 속 `from 'node:test'` 는 오탐 — 그 파일을 실행하거나 이름 위반으로
// **시끄럽게** 실패하니 메시지가 가리키는 파일의 주석·문자열을 고친다. `from /* c */ 'node:test'` 처럼 사이에 주석을 끼우면 못 찾는다.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const APP_DIR = path.dirname(path.dirname(SELF))
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const SOURCE = /\.[cm]?[jt]sx?$/
const VITEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const IMPORTS_NODE_TEST = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]node:test['"]/

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && SOURCE.test(entry.name) ? [full] : []
  })
}

const files = walk(APP_DIR)
  .filter((file) => file !== SELF && IMPORTS_NODE_TEST.test(fs.readFileSync(file, 'utf8')))
  .map((file) => path.relative(APP_DIR, file))
  .sort()

if (files.length === 0) {
  console.error('run-nodetest: node:test 파일을 하나도 찾지 못했다 — 0건 통과는 통과가 아니다')
  process.exit(1)
}
const misnamed = files.filter((file) => VITEST_NAME.test(path.basename(file)))
if (misnamed.length > 0) {
  console.error(`run-nodetest: node:test 파일이 vitest 이름을 쓴다 — *.nodetest.mjs 로 바꿀 것:\n  ${misnamed.join('\n  ')}`)
  process.exit(1)
}

console.log(`run-nodetest: node:test 파일 ${files.length}개\n  ${files.join('\n  ')}`)
const failed = files.filter((file) => {
  console.log(`\nrun-nodetest: ▶ ${file}`)
  const run = spawnSync(process.execPath, ['--test-reporter=spec', file], { cwd: APP_DIR, stdio: 'inherit' })
  return run.status !== 0
})
console.log(`\nrun-nodetest: ${files.length}개 실행 · 실패 ${failed.length}개${failed.length > 0 ? `\n  ${failed.join('\n  ')}` : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
