#!/usr/bin/env node
// LIFE-670 수정 2(r2 L-A) — 덮기 폴백에서 맨 오른쪽 칸 카드를 고르면 선택 맞춤이 그 카드를 패널 왼쪽까지 끌어오는가 + 여백 없는 대조.
// app/ 에서(먼저 `npm run build`):  node scripts/l670/q-overlay.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
// 창 1100(main < 960 → 덮기). 맨 오른쪽 칸 카드는 패널 밑이라 hit-test 클릭이 닿지 않는다 — 카드 요소에 DOM click 을 보낸다(리뷰 r2 프로브와 같은 방식).
// 대조: 덮기 폴백 그릇 오른쪽 여백 규칙(task-detail.css)을 같은 특이도 + !important 스타일로 12px 로 되돌린 뒤 같은 조작.
import { session, ctl, sleep, until } from './q-lib.mjs'

const [ROOT, OUT, SHOT_DIR] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-overlay.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더>')
  process.exit(2)
}
const s = session({ root: ROOT, out: OUT, shotDir: SHOT_DIR })
const measure = (key) => s.js(`(() => {
  const card = document.querySelector('[data-tasks-board] [data-issue-card="${key}"]'); const aside = document.querySelector('[data-issue-detail]')
  const box = document.querySelector('[data-tasks-scroll="board"]'); const c = card?.getBoundingClientRect(); const a = aside?.getBoundingClientRect()
  return { placement: document.querySelector('.tasks-main')?.dataset.detailLayout ?? null, detail: aside?.getAttribute('data-issue-detail') ?? null,
    card: c ? { left: Math.round(c.left), right: Math.round(c.right) } : null, asideLeft: a ? Math.round(a.left) : null,
    scrollLeft: box?.scrollLeft ?? null, scrollMax: box ? box.scrollWidth - box.clientWidth : null, padRight: box ? getComputedStyle(box).paddingRight : null }
})()`)
/** 상세를 닫고 그릇을 처음으로 둔 뒤 맨 오른쪽 칸 첫 카드를 DOM click 으로 고른다. */
const pickLast = async () => {
  if (await s.js(`!!document.querySelector('[data-issue-detail]')`)) {
    await s.click('[data-issue-close]')
    await until(async () => (await s.js(`!document.querySelector('[data-issue-detail]')`)) === true, { timeoutMs: 5_000, label: '상세 닫기' })
  }
  const key = await s.js(`(() => { const box = document.querySelector('[data-tasks-scroll="board"]'); box.scrollLeft = 0
    const zones = [...document.querySelectorAll('[data-tasks-board] [data-drop-zone^="col:"]')]; const card = zones.at(-1)?.querySelector('[data-issue-card]')
    card?.click(); return card?.getAttribute('data-issue-card') ?? null })()`)
  await until(() => s.js(`!!document.querySelector('[data-issue-detail="${key}"]')`), { timeoutMs: 10_000, label: `상세 ${key}` })
  await sleep(500)
  return key
}

await s.finish(async () => {
  await s.boot({ token: 'mock_l670_overlay' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1100, height: 800 })
  await sleep(500)
  const key = await pickLast()
  const m = await measure(key)
  s.log('여백 있음', { key, ...m })
  s.judge(`L-A 덮기 폴백 · 맨 오른쪽 칸 카드 ${key} 선택 → card.right <= aside.left`, m.placement === 'overlay' && m.card !== null && m.card.right <= m.asideLeft, JSON.stringify(m))
  await s.shot('q-overlay-with-pad')
  // 대조 — 오른쪽 여백 규칙을 끈다.
  await s.js(`(() => { const st = document.createElement('style'); st.id = 'l670-control'; st.textContent = '.tasks-main[data-detail-layout="overlay"] .tasks-scroll { padding-right: 12px !important; }'; document.head.append(st); return true })()`)
  const key2 = await pickLast()
  const c = await measure(key2)
  s.log('대조 여백 없음', { key: key2, ...c })
  s.judge(`L-A 대조 — 여백 규칙을 끄면 같은 카드가 패널 밑(card.right > aside.left, 스크롤 끝)`, c.placement === 'overlay' && c.card !== null && c.card.right > c.asideLeft && c.scrollLeft === c.scrollMax, JSON.stringify(c))
  await s.shot('q-overlay-control-no-pad')
})
