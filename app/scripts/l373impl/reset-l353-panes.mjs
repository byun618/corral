// C2(단일 pane 회귀) 를 돌리기 **전에** LIFE-353 세션을 pane 하나로 되돌린다.
//
// C2 하네스는 안 건드린다 (R5: 하네스 무수정). herdr 는 pane 을 영속하므로 ② 실험이 남긴
// 분할 위에서 C2 를 돌리면 통째로 무효다 — 실측: `xtermSize` 가 138×51 이어야 할 자리에
// 65×51 이 찍혀 S1 이 51행씩 전부 불일치로 나왔다. **단일 pane 회귀인데 pane 이 둘이었다.**
//
// 격리는 l353 lib 의 가드를 그대로 빌린다 (`sessionDir` 이 접두·사용자 세션 두 축을 본다).

import { execFileSync } from 'node:child_process'
import { SESSION, sessionDir, sleep } from '../l353/lib.mjs'

sessionDir(SESSION) // 가드를 먼저 통과시킨다 — 여기서 거절되면 아무것도 안 한다.

const ctl = (...args) => {
  const out = execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' })
  return out.trim().length === 0 ? null : JSON.parse(out).result
}

const layout = () => ctl('pane', 'layout').layout

const before = layout()
const keep = before.focused_pane_id
for (const pane of before.panes) if (pane.pane_id !== keep) ctl('pane', 'close', pane.pane_id)
await sleep(900)
const after = layout()
console.log(JSON.stringify({ 세션: SESSION, 닫은수: before.panes.length - after.panes.length, 남은수: after.panes.length, area: after.area }))
if (after.panes.length !== 1) throw new Error(`pane 하나로 못 돌렸다 (${after.panes.length}개)`)
