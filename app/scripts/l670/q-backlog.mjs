#!/usr/bin/env node
// LIFE-670 수정 2(r2 L-B) — body 400(밀기 최소)에서 백로그가 가로 스크롤될 때 구획 머리·행 배경이 스크롤 폭을 채우는가 · 구획 이름이 보이는가 ·
// 백로그 행을 다른 구획으로 끌어 놓기 1회(출처 placement 변경). app/ 에서(먼저 `npm run build`):
//   node scripts/l670/q-backlog.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
// 끌기는 원 마우스(mouseDown 손잡이 → mouseMove 8걸음 → mouseUp). 놓을 점 = 백로그 구획 놓기 영역 가운데 — 자동 스크롤 띠(40px) 밖인지 함께 기록한다.
import { session, ctl, sleep, until } from './q-lib.mjs'

const [ROOT, OUT, SHOT_DIR] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-backlog.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더>')
  process.exit(2)
}
const s = session({ root: ROOT, out: OUT, shotDir: SHOT_DIR })
const shape = () => s.js(`(() => {
  const box = document.querySelector('[data-tasks-scroll="backlog"]'); const b = box.getBoundingClientRect()
  const aside = document.querySelector('[data-issue-detail]')
  return { placement: document.querySelector('.tasks-main')?.dataset.detailLayout ?? null, asideLeft: aside ? Math.round(aside.getBoundingClientRect().left) : null,
    box: { left: Math.round(b.left), right: Math.round(b.right), scrollLeft: box.scrollLeft, scrollMax: box.scrollWidth - box.clientWidth },
    sections: [...document.querySelectorAll('[data-backlog-section]')].map((sec) => {
      const r = sec.getBoundingClientRect(); const head = sec.querySelector('.tasks-backlog-head'); const h = head.getBoundingClientRect()
      const label = (head.querySelector('.tasks-backlog-title') ?? head.querySelector('span')).getBoundingClientRect()
      return { id: sec.getAttribute('data-backlog-section'), right: Math.round(r.right), innerRight: Math.round(r.right - parseFloat(getComputedStyle(sec).borderRightWidth)),
        headRight: Math.round(h.right), label: { left: Math.round(label.left), right: Math.round(label.right) },
        rows: [...sec.querySelectorAll('[data-issue-row]')].map((row) => { const rr = row.getBoundingClientRect(); let maxRight = Math.round(rr.right)
          for (const child of row.querySelectorAll('*')) { const c = child.getBoundingClientRect(); if (c.width > 0) maxRight = Math.max(maxRight, Math.round(c.right)) }
          return { key: row.getAttribute('data-issue-row'), right: Math.round(rr.right), maxRight, title: Math.round(row.querySelector('.tasks-row-title').getBoundingClientRect().width) } }) }
    }) }
})()`)

await s.finish(async () => {
  const connectionId = await s.boot({ token: 'mock_l670_backlog' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1241, height: 800 })
  await sleep(500)
  await s.showView('backlog')
  // 대조(환경 L670_UNDO_LB=1): r1 의 백로그 CSS(구획 overflow-x:auto · 백로그 min-width 없음 · sticky 없음)로 되돌린다 — 채움·이름 판정이 미달이어야 한다(이 회차 exit 1 은 기대값).
  if (process.env.L670_UNDO_LB === '1') s.log('대조 — r1 백로그 CSS 주입', await s.js(`(() => { const st = document.createElement('style'); st.textContent = '.tasks-backlog { min-width: auto !important } .tasks-backlog-section { overflow-x: auto !important; overflow-y: hidden !important } .tasks-backlog-title { position: static !important }'; document.head.append(st); return true })()`))
  await s.click('[data-tasks-scroll="backlog"] [data-issue-row="CORE-2"]')
  await until(() => s.js(`!!document.querySelector('[data-issue-detail="CORE-2"]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
  await sleep(400)
  const start = await shape()
  s.log('처음', start)
  await s.js(`(() => { const box = document.querySelector('[data-tasks-scroll="backlog"]'); box.scrollLeft = box.scrollWidth; return box.scrollLeft })()`)
  await sleep(200)
  const end = await shape()
  s.log('스크롤 끝', end)
  const fill = end.sections.every((sec) => sec.headRight === sec.innerRight && sec.rows.every((row) => row.right === sec.innerRight && row.maxRight <= sec.innerRight))
  s.judge('L-B 스크롤 끝 — 구획 머리·행이 구획 안쪽 폭을 채우고 행 내용이 구획 안 · 구획 right <= aside.left',
    end.placement === 'push' && fill && end.sections.every((sec) => sec.right <= end.asideLeft), JSON.stringify({ box: end.box, asideLeft: end.asideLeft, sections: end.sections.map((sec) => ({ id: sec.id, right: sec.right, innerRight: sec.innerRight, headRight: sec.headRight, rows: sec.rows.map((row) => [row.key, row.right, row.maxRight]) })) }))
  s.judge('L-B 스크롤 끝 — 구획 이름이 그릇 안에 보인다(label.left >= 그릇 left)', end.sections.every((sec) => sec.label.left >= end.box.left), JSON.stringify({ boxLeft: end.box.left, labels: end.sections.map((sec) => [sec.id, sec.label]) }))
  await s.shot('q-backlog-scrolled')

  // 끌기 — 보드 구획 CORE-4 → 백로그 구획
  await s.js(`(() => { document.querySelector('[data-tasks-scroll="backlog"]').scrollLeft = 0; return true })()`)
  await sleep(200)
  const before = await s.js(`window.corral.workRequest({ requestId: 'l670-bl-before', connectionId: '${connectionId}', call: { op: 'getItem', itemId: 'm-4' } }).then((r) => r.ok ? r.result.item.placement : JSON.stringify(r))`)
  const geo = await s.js(`(() => {
    const grip = document.querySelector('[data-backlog-section="board"] [data-issue-row="CORE-4"] .tasks-grip')?.getBoundingClientRect()
    const zone = document.querySelector('[data-drop-zone="sec:backlog"]')?.getBoundingClientRect(); const box = document.querySelector('[data-tasks-scroll="backlog"]').getBoundingClientRect()
    if (!grip || !zone) return null
    const drop = { x: Math.round(zone.left + zone.width / 2), y: Math.round(zone.top + zone.height / 2) }
    return { from: { x: Math.round(grip.left + grip.width / 2), y: Math.round(grip.top + grip.height / 2) }, drop,
      outsideBands: drop.x > box.left + 40 && drop.x < box.right - 40 && drop.y > box.top + 40 && drop.y < box.bottom - 40, zone: { top: Math.round(zone.top), height: Math.round(zone.height) } }
  })()`)
  s.log('끌기 기하', geo)
  if (geo === null) throw new Error('손잡이·놓기 영역 없음')
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', x: geo.from.x, y: geo.from.y })
  for (let index = 1; index <= 8; index += 1) {
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(geo.from.x + ((geo.drop.x - geo.from.x) * index) / 8), y: Math.round(geo.from.y + ((geo.drop.y - geo.from.y) * index) / 8) })
    await sleep(40)
  }
  await sleep(250) // 입력 큐가 eval 을 앞지르지 않게
  const hovering = await s.js(`({ previews: document.querySelectorAll('.tasks-drag-preview').length, over: document.querySelector('[data-backlog-section].is-over')?.getAttribute('data-backlog-section') ?? null })`)
  s.log('끄는 중', hovering)
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', x: geo.drop.x, y: geo.drop.y })
  const moved = await until(() => s.js(`!!document.querySelector('[data-backlog-section="backlog"] [data-issue-row="CORE-4"]')`), { timeoutMs: 10_000, label: '백로그 구획에 CORE-4' }).then(() => true).catch(() => false)
  await sleep(500)
  const after = await s.js(`window.corral.workRequest({ requestId: 'l670-bl-after', connectionId: '${connectionId}', call: { op: 'getItem', itemId: 'm-4' } }).then((r) => r.ok ? r.result.item.placement : JSON.stringify(r))`)
  s.log('끌기 결과', { before, after, moved })
  s.judge('L-B 끌기 — 백로그 행(보드 구획 CORE-4) → 백로그 구획 놓기 · 출처 placement board → backlog', geo.outsideBands && hovering.previews === 1 && moved && before === 'board' && after === 'backlog', JSON.stringify({ before, after, moved, hovering, outsideBands: geo.outsideBands }))
  await s.shot('q-backlog-dropped')
})
