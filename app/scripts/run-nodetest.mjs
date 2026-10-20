// LIFE-517 — `npm test` 의 node:test 쪽. `npm test` = `vitest run` 다음에 이 스크립트.
//
// 이름 규약 (app/ 의 테스트 두 러너):
//   - vitest 파일 = `*.test.*` · `*.spec.*` (vitest 기본 include, 설정 파일 없음)
//   - node:test 파일 = `node:test` 를 import 하는 파일. 이름은 **vitest 패턴 밖**으로 짓는다(`*.nodetest.mjs` 권장)
// 한 파일만: `npx vitest run <파일>` · `node --test <파일>`. `npm test -- <필터>` 는 vitest 에 닿지 않는다(`&&` 앞 명령이라).
//
// 파일 목록을 손으로 적지 않는다 — `app/` 아래에서 `node:test` 를 import 하는 파일을 **내용으로** 찾아 전부 돌린다.
// 그래서 이름을 무엇으로 짓든 새 node:test 파일이 조용히 빠지지 않는다. 대신 아래 셋은 실패로 끝낸다:
//   ① 찾은 파일이 0개 — `node --test <glob>` 은 0건이면 exit 0 으로 통과시킨다(LIFE-517 00-analysis §3 G4)
//   ② node:test 파일이 vitest 이름(`*.test.*`·`*.spec.*`)을 쓴다 — vitest 가 수집해 `No test suite found` 로 실패한다
//   ③ 이 러너 안에서 이 러너가 다시 돈다(복사본·하드링크가 테스트 파일로 잡힌 경우) — 환경변수로 재진입을 막는다
//
// 탐색 범위: 점 폴더·점 파일도 본다. 빼는 것은 남의 코드·산출물·VCS 뿐이다 — 어느 깊이든 `node_modules`(의존성)·`.git`(VCS),
// `app/` 바로 아래의 `out`·`dist`(빌드 산출물 — eslint ignores `out/**`·`dist/**` 와 같은 루트 기준). 확장자는 vitest include 와
// 같은 `[cm]?[jt]sx?`. 심볼릭 링크는 따라가지 않는다 — 링크 대상이 `app/` 안이면 실제 경로로 잡힌다.
// 이 러너 자신도 뺀다 — 아래 주석에 탐색 대상 문구가 있어, 빼지 않으면 자기를 테스트 파일로 돌린다.
// 실행: `node:test` 의 `run({ files })` — `node --test` 와 같은 파일별 자식 프로세스 격리라 판정이 같다(`process.exit(0)` 으로
// 일찍 끝나도 이미 보고된 실패는 실패, `only` 는 `--test-only` 없이 무시). `node --test <경로>` 는 경로를 글롭으로 읽어
// `[1]`·`*` 가 든 경로를 조용히 놓치지만(r1 R1-claude-01) `files` 는 경로 그대로 쓴다. 종료코드는 최종 요약의 성공 여부.
// 파일은 한 번에 하나씩 돈다(`run()` 의 `concurrency` 기본값 — `--test-concurrency` 없는 직렬, `node --test` CLI 는 병렬).
// 의도한 것이다: 파일 간 공유 상태(소켓·고정 임시 경로)가 다투지 않고 로그가 파일 순서를 따른다. 대가는 시간이 파일 수에 선형인 것.
// 끝나지 않는 테스트(풀리지 않는 Promise·남은 핸들)는 실패가 아니라 멈춘다 — `node --test` 와 같다. 전체 시간 상한은 두지 않는다.
// 테스트가 0개인 node:test 파일은 `node --test` 처럼 통과로 센다 — 실행된 파일 목록은 로그 머리에 찍힌다.
// 탐색 한계: import 를 정규식으로 본다. 주석·문자열 속 `from 'node:test'` 는 오탐이다 — 이름이 vitest 패턴이면 ② 로 실패하고,
// 아니면 그 파일을 실행한다(테스트가 없으면 통과 — 목록에 나오니 그 파일의 주석·문자열을 고친다).
// `from /* c */ 'node:test'` 처럼 사이에 주석을 끼우면 못 찾는다.

import fs from 'node:fs'
import path from 'node:path'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'

const REENTRY = 'CORRAL_RUN_NODETEST'
if (process.env[REENTRY]) {
  console.error(`run-nodetest: 재진입 — 이 러너가 다른 run-nodetest 안에서 돌았다(복사본·하드링크가 테스트 파일로 잡혔다): ${process.argv[1]}`)
  process.exit(1)
}
process.env[REENTRY] = '1'

const SELF = fileURLToPath(import.meta.url)
const APP_DIR = path.dirname(path.dirname(SELF))
const SKIP_ANY_DEPTH = new Set(['node_modules', '.git'])
const SKIP_AT_ROOT = new Set(['out', 'dist'].map((name) => path.join(APP_DIR, name)))
const SOURCE = /\.[cm]?[jt]sx?$/
const VITEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const IMPORTS_NODE_TEST = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]node:test['"]/

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (SKIP_ANY_DEPTH.has(entry.name) || SKIP_AT_ROOT.has(full)) return []
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
process.chdir(APP_DIR)
let summary = null
const stream = run({ files: files.map((file) => path.join(APP_DIR, file)) })
stream.on('test:summary', (data) => { if (data.file === undefined) summary = data })
stream.on('end', () => {
  // 최종 요약이 없으면 실행이 끝까지 가지 못한 것이다 — 통과로 세지 않는다.
  const ok = summary?.success === true
  // 건너뜀 · todo 도 요약 줄에 드러낸다(LIFE-603 R3-J) — 건너뛴 칸이 「통과」 에 묻히지 않게.
  const counts = summary?.counts
  console.log(`run-nodetest: ${files.length}개 실행 · ${ok ? '통과' : '실패'}${counts ? ` (tests ${counts.tests} · fail ${counts.failed} · cancelled ${counts.cancelled} · skipped ${counts.skipped} · todo ${counts.todo})` : ' (최종 요약 없음)'}`)
  if (counts !== undefined && counts.skipped + counts.todo > 0) console.log(`run-nodetest: 건너뜀 ${counts.skipped} · todo ${counts.todo} — 이 칸들은 실행되지 않았다`)
  process.exitCode = ok ? 0 : 1
})
stream.compose(spec).pipe(process.stdout)
