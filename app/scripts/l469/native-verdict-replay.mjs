// LIFE-469 수정 라운드 1 R1-07 — native-k8.mjs 의 새 기대 순서 판정을 **보존된 네이티브 원자료에 다시 대본다**(OS 입력 없음).
// r2 통과 회차는 기대=관측, r1 사건 회차(입력 미도착·순서 무변경)는 기대≠관측이어야 한다 — 후자가 음성 대조다.
// 사용: node native-verdict-replay.mjs <raw/claude/native 폴더>
import fs from 'node:fs'
import path from 'node:path'

const rawd = process.argv[2]
const src = fs.readFileSync(path.join(import.meta.dirname, 'native-k8.mjs'), 'utf8')
const body = src.slice(src.indexOf('function expectedOrder'), src.indexOf('/** 창 안 좌표'))
const { expectedOrder, observedOrder } = new Function(`${body};return { expectedOrder, observedOrder }`)()
const CASES = [
  { file: 'r2/drag-repo-try1.json', step: 'drag-repo', key: '/private/tmp/l469nfx/fxrepo', want: true },
  { file: 'r2/drag-card-try1.json', step: 'drag-card', key: '/Users/byun/repos/byun618/corral', want: true },
  { file: 'drag-repo.json', step: 'drag-repo', key: '/private/tmp/l469nfx/fxrepo', want: false },
]
const results = CASES.map((c) => {
  const o = JSON.parse(fs.readFileSync(path.join(rawd, c.file), 'utf8'))
  const expected = expectedOrder({ step: c.step, before: o.before, moving: o.points.client.moving, key: c.key })
  const observed = observedOrder({ step: c.step, after: o.after, key: c.key })
  const asExpected = JSON.stringify(expected) === JSON.stringify(observed)
  return { file: c.file, asExpected, want: c.want, ok: asExpected === c.want, expectedLength: expected.length, observedLength: observed.length }
})
console.log(JSON.stringify(results, null, 1))
process.exit(results.every((r) => r.ok) ? 0 : 1)
