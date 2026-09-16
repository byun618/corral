// `pane.resize` 의 **산술**을 herdr 에게 직접 물어 본다 (F2-2 의 전제).
//
// 기준서는 `amount = Δ비율` 이라고만 적혀 있다. 드래그 고스트가 **끄는 칸 수를 정확히 말하려면**
// 그 이상을 알아야 한다 — 부호는 어디서 오나, 한 번에 얼마까지 미나, 비율이 셀로 어떻게 떨어지나.
// 추측하지 않고 격리 세션에서 재고 원자료로 남긴다.
//
// 제3 오라클만 쓴다(관문 ④): 앱을 띄우지 않고 control CLI 로만 쓰고 읽는다.

import { ctl, layout, m0End, m0Start, sleep, writeRaw, SESSION } from './lib.mjs'

const M0 = m0Start()

const snapshot = () => {
  const live = layout()
  return {
    // 분할이 여럿이면 **전부** 적는다. 하나만 적으면 `pane.resize` 가 실제로 민 분할과 읽은 분할이
    // 어긋난 채로 표가 만들어진다 (첫 회차에서 실제로 그렇게 나왔다 — 뿌리만 읽고 안쪽을 밀었다).
    분할: live.splits.map((split) => ({ id: split.id, direction: split.direction, ratio: split.ratio, span: split.rect.width })),
    폭: live.area.width,
    pane: live.panes.map((pane) => ({ paneId: pane.pane_id, x: pane.rect.x, width: pane.rect.width })),
  }
}

/** 재기 전에 **탭을 pane 하나로 되돌린다** — 남은 분할이 있으면 중첩이 생겨 읽는 분할이 흔들린다. */
const target = ctl('pane', 'layout').layout.focused_pane_id
if (typeof target !== 'string') throw new Error('포커스 pane 을 못 읽었다')
for (const paneId of layout().panes.map((pane) => pane.pane_id).filter((id) => id !== target)) {
  ctl('pane', 'close', paneId)
}
await sleep(800)
if (layout().panes.length !== 1) throw new Error('pane 하나로 못 돌렸다 — 손으로 정리하고 다시 돌려라')

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 대상: target, 시작: snapshot(), 단계: [] }

const step = async (설명, run) => {
  run()
  await sleep(800)
  const after = snapshot()
  결과.단계.push({ 설명, ...after })
  console.log(설명, JSON.stringify(after))
  return after
}

await step('분할 직후', () => ctl('pane', 'split', '--pane', target, '--direction', 'right'))

const resize = (direction, amount) => () =>
  ctl('pane', 'resize', '--pane', target, '--direction', direction, '--amount', String(amount))

// ① 부호는 amount 가 아니라 direction 이 준다 — 음수를 넣어도 같은 쪽으로 민다.
await step('right +0.05', resize('right', 0.05))
await step('right -0.05 (음수)', resize('right', -0.05))
// ② 한 번에 미는 양의 상한.
await step('left 0.7 (상한 확인)', resize('left', 0.7))
// ③ 비율 자체의 클램프.
await step('left 0.5 (하한 확인)', resize('left', 0.5))
await step('right 0.5', resize('right', 0.5))
await step('right 0.5 (한 번 더 — 상한 확인)', resize('right', 0.5))
// ④ ②의 `left 0.7` 은 마침 하한에 떨어져 **상한 때문인지 클램프 때문인지 안 갈린다**.
//    0.9 에서 0.7 을 빼면 0.2 여야 하는데 한 번에 0.5 만 밀리면 0.4 에 선다 — 거기서 갈린다.
await step('right 0.9 에서 left 0.7 (0.5 상한만 성립하면 0.4)', resize('left', 0.7))

// 뒷정리 — 만든 pane 을 닫아 원래대로.
const extra = layout().panes.map((pane) => pane.pane_id).filter((id) => id !== target)
for (const paneId of extra) ctl('pane', 'close', paneId)
await sleep(800)
결과.정리후 = snapshot()

결과.M0b = m0End()
writeRaw('f2-resize-semantics.json', 결과)
