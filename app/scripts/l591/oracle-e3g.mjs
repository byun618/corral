// LIFE-591 수정 r1 R1-K — close-quit.mjs E3ⓖ 판별식의 음성 대조. 리뷰어 `/tmp/l591-review-r1/oracle-check.mjs` 의 네 입력을 옮겼다.
// 음성 3경우(null·빈 문자열·틀린 내용)와 수정 내용(Q…)은 **실패**해야 하고, 원본 첫 줄은 통과해야 한다. 하나라도 어긋나면 종료 1.
// 사용: node scripts/l591/oracle-e3g.mjs [--predicate old|new]   (old = 1a670faf6 의 판별식 사본 — 옛 판별식이 음성을 통과시킴을 보이는 회차)
import { parseArgs } from 'node:util'
import { reopenedMatches } from './lib.mjs'

const { values } = parseArgs({ options: { predicate: { type: 'string', default: 'new' } } })
const expectedFirst = '// 파일 탭 첫 화면 — TypeScript 샘플 (LIFE-590 fixture)'
const predicate = values.predicate === 'old' ? (reopened) => reopened.tab === 'false' && !String(reopened.first).startsWith('Q') : (reopened) => reopenedMatches(reopened, expectedFirst)
const cases = [
  { name: 'null', reopened: { tab: 'false', first: null }, want: false },
  { name: 'empty', reopened: { tab: 'false', first: '' }, want: false },
  { name: 'wrong', reopened: { tab: 'false', first: 'WRONG CONTENT' }, want: false },
  { name: 'unsaved', reopened: { tab: 'false', first: `Q${expectedFirst}` }, want: false },
  { name: 'original', reopened: { tab: 'false', first: expectedFirst }, want: true },
]
let bad = 0
for (const row of cases) {
  const got = predicate(row.reopened)
  if (got !== row.want) bad += 1
  console.log(`${got === row.want ? 'PASS' : 'FAIL'} ${row.name} passes=${got} want=${row.want}`)
}
console.log(bad === 0 ? 'ALL PASS' : `FAILED ${bad}`)
process.exit(bad === 0 ? 0 : 1)
