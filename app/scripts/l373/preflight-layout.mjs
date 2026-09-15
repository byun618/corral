// LIFE-373 분석 프리플라이트 — herdr 의 pane 레이아웃 API 가 "코디네이터가 읽은 대로" 도는지
// 격리 세션에서 확인한다. 구현이 아니라 **분석 근거**다 (00-analysis 대조표 A1~A4 의 원자료).
//
// 격리: `life373-` 접두 세션만 (l353/l356 lib 의 관문 ④ 와 같은 규칙). 사용자 default 불가침.
// 전제: `script -q /dev/null herdr --session life373-claude` 로 세션이 이미 떠 있다.

import { execFileSync } from 'node:child_process'

const SESSION = process.env.L373_SESSION ?? 'life373-claude'
if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)

const herdr = (...args) => JSON.parse(execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' })).result

const layout = () => {
  const l = herdr('pane', 'layout').layout
  return {
    area: l.area,
    zoomed: l.zoomed,
    focused: l.focused_pane_id,
    panes: l.panes.map((p) => ({ id: p.pane_id, rect: p.rect, focused: p.focused })),
    splits: l.splits.map((s) => ({ id: s.id, direction: s.direction, ratio: s.ratio, rect: s.rect })),
  }
}

const out = { session: SESSION, at: new Date().toISOString(), steps: [] }
const step = (label, value) => out.steps.push({ label, value })

// A1 — 분할 전 (단일 pane 은 split 0건으로 접혀 보인다)
step('before-split', layout())

// A2 — split 은 ratio 를 받는다. 결과 레이아웃에 splits[0].ratio 로 그대로 박힌다
const created = herdr('pane', 'split', '--direction', 'right', '--ratio', '0.5').pane
step('after-split(ratio=0.5)', { created: created.pane_id, layout: layout() })

// A3 — resize --amount 는 **비율 델타**다 (셀 수가 아니다). 0.05 씩 두 번, 0.2 한 번
for (const amount of ['0.05', '0.05', '0.2']) {
  herdr('pane', 'resize', '--direction', 'right', '--amount', amount)
  step(`after-resize(right,+${amount})`, layout())
}

// A4 — 인접/가장자리/줌은 서버가 계산해 준다 (클라이언트가 트리를 뒤질 필요가 없다)
step('neighbor(right)', herdr('pane', 'neighbor', '--direction', 'right'))
step('edges', herdr('pane', 'edges'))
herdr('pane', 'zoom', '--on')
step('after-zoom-on', layout())
herdr('pane', 'zoom', '--off')
step('after-zoom-off', layout())

// 정리 — 만든 pane 만 닫는다
herdr('pane', 'close', created.pane_id)
step('after-close', layout())

process.stdout.write(JSON.stringify(out, null, 2) + '\n')
