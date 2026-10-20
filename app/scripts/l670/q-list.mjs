#!/usr/bin/env node
// LIFE-670 수정 3(r3 L-F·L-G) — 리스트 보기 가로 스크롤 모양.
// ① 창 1241(body 400, 밀기): 리스트 그릇 가로 스크롤 끝에서 묶음 머리·행·「더 불러오기」 right 가 모두 같고(스크롤 폭 채움) 묶음 이름 left >= 그릇 left.
// ② 창 900(덮기 폴백): 묶음 머리·푸터 글자가 한 줄(텍스트 노드 줄 수 1)이고 높이가 CSS 높이 그대로.
// app/ 에서(먼저 `npm run build`):  node scripts/l670/q-list.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
import { session, ctl, sleep, until } from './q-lib.mjs'

const [ROOT, OUT, SHOT_DIR] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-list.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더>')
  process.exit(2)
}
const s = session({ root: ROOT, out: OUT, shotDir: SHOT_DIR })
const shape = () => s.js(`(() => {
  const box = document.querySelector('[data-tasks-scroll="list"]'); const b = box.getBoundingClientRect()
  const lines = (el) => { const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let most = 0
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) { if (node.textContent.trim().length === 0) continue
      const range = document.createRange(); range.selectNodeContents(node); const tops = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.top).sort((a, c) => a - c)
      let count = tops.length === 0 ? 0 : 1; for (let i = 1; i < tops.length; i += 1) if (tops[i] - tops[i - 1] > 6) count += 1; most = Math.max(most, count) }
    return most }
  const part = (el) => { const r = el.getBoundingClientRect(); return { right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), cssHeight: getComputedStyle(el).height, lines: lines(el) } }
  return { placement: document.querySelector('.tasks-main')?.dataset.detailLayout ?? null,
    box: { left: Math.round(b.left), right: Math.round(b.right), scrollLeft: box.scrollLeft, scrollMax: box.scrollWidth - box.clientWidth },
    groups: [...box.querySelectorAll('.tasks-list-group')].map((g) => ({ id: g.getAttribute('data-list-group'), ...part(g), title: (() => { const t = (g.querySelector('.tasks-list-group-title') ?? g.querySelector('span')).getBoundingClientRect(); return { left: Math.round(t.left), right: Math.round(t.right) } })() })),
    rows: [...box.querySelectorAll('[data-issue-row]')].map((row) => ({ key: row.getAttribute('data-issue-row'), ...part(row) })),
    more: [...box.querySelectorAll('[data-tasks-more]')].map(part) }
})()`)

await s.finish(async () => {
  await s.boot({ token: 'mock_l670_list' })
  await ctl(ROOT, { cmd: 'resize-window', width: 1241, height: 800 })
  await sleep(500)
  await s.showView('list')
  // 대조(환경 L670_UNDO_LF=1): 수정 3 리스트 CSS 를 되돌린다(래퍼 min-width·이름 sticky·nowrap 끔) — 판정이 미달이어야 한다(이 회차 exit 1 은 기대값).
  if (process.env.L670_UNDO_LF === '1') s.log('대조 — 수정 3 리스트 CSS 되돌림 주입', await s.js(`(() => { const st = document.createElement('style'); st.textContent = '.tasks-list-inner { min-width: auto !important } .tasks-list-group-title { position: static !important } .tasks-list-group, .tasks-list-more { white-space: normal !important }'; document.head.append(st); return true })()`))
  await s.click('[data-tasks-scroll="list"] [data-issue-row="CORE-2"]')
  await until(() => s.js(`!!document.querySelector('[data-issue-detail="CORE-2"]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
  await sleep(400)
  await s.js(`(() => { const box = document.querySelector('[data-tasks-scroll="list"]'); box.scrollLeft = box.scrollWidth; return box.scrollLeft })()`)
  await sleep(200)
  const end = await shape()
  s.log('1241 스크롤 끝', end)
  const rights = [...end.groups, ...end.rows, ...end.more].map((part) => part.right)
  s.judge('L-F 스크롤 끝 — 묶음 머리·행·더 불러오기 right 가 모두 그릇 오른쪽 끝과 같다(스크롤 폭 채움 — 2회차 대조가 「서로 같음」만으로는 통과해 강화) · 실제로 스크롤됨', end.placement === 'push' && end.box.scrollMax > 0 && end.box.scrollLeft === end.box.scrollMax && end.groups.length > 0 && end.rows.length > 0 && new Set(rights).size === 1 && rights[0] === end.box.right,
    JSON.stringify({ box: end.box, rights: [...new Set(rights)], groups: end.groups.map((g) => [g.id, g.right]), rows: end.rows.map((r) => [r.key, r.right]), more: end.more.map((m) => m.right) }))
  s.judge('L-F 스크롤 끝 — 묶음 이름이 그릇 안에 보인다(title.left >= 그릇 left)', end.groups.every((g) => g.title.left >= end.box.left), JSON.stringify({ boxLeft: end.box.left, titles: end.groups.map((g) => [g.id, g.title]) }))
  await s.shot('q-list-1241-scrolled')

  await ctl(ROOT, { cmd: 'resize-window', width: 900, height: 800 })
  await sleep(600)
  const narrow = await shape()
  s.log('900 덮기 폴백', narrow)
  const heads = [...narrow.groups, ...narrow.more]
  s.judge('L-G 창 900 덮기 폴백 — 묶음 머리·푸터 글자 한 줄 · 높이 = CSS 높이', narrow.placement === 'overlay' && heads.length > 0 && heads.every((part) => part.lines === 1 && `${part.height}px` === part.cssHeight),
    JSON.stringify(heads.map((part) => ({ id: part.id ?? 'more', width: part.width, height: part.height, css: part.cssHeight, lines: part.lines }))))
  await s.shot('q-list-900-overlay')
})
