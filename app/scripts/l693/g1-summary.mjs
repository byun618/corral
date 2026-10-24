// LIFE-693 g1 요약 — g.mjs 가 남긴 측정 JSON 만 읽어 01-criteria K1–K4 통과선과 대조한다(판정 A·B 는 수치만, 판정은 코디).
// 새로 재지 않는다. 입력 회차는 아래 RUNS 에 못박는다(실패 회차 orphan-impl-1·2 는 원자료로 남고 대조에 쓰지 않는다 — 이유는 각 txt).
// 사용(app/ 에서): node scripts/l693/g1-summary.mjs > ../specs/LIFE-693-confirm-scroll/raw/claude/g1-summary.txt
import fs from 'node:fs'
import path from 'node:path'

const G1 = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../specs/LIFE-693-confirm-scroll/raw/claude/g1')
const RUNS = { orphanImpl: 'orphan-impl-3', orphanBase: 'orphan-base-1', tabsImpl: 'tabs-impl-1', tabsBase: 'tabs-base-1' }
const read = (run, tag) => JSON.parse(fs.readFileSync(path.join(G1, run, `${tag}.json`), 'utf8'))
const rows = []
const row = (item, pass, detail) => rows.push({ item, verdict: pass === null ? '기록' : pass ? '통과' : '미달', detail })
const hits4 = (m) => [m.title, m.x, m.cancel, m.ok].every((h) => h.exists && h.hit)
const hitText = (m) => ['title', 'x', 'cancel', 'ok'].map((k) => `${k}=${m[k].hit ? 'hit' : `✗(${m[k].inViewport ? m[k].at : '뷰포트 밖'})`}`).join(' ')

console.log(`# LIFE-693 g1 요약 · 입력 ${JSON.stringify(RUNS)} · ${new Date().toISOString()}`)

// K1ⓐⓑⓒ — 수정 빌드, 카드 밖 「모두 닫기」 32줄
for (const h of [800, 600, 300]) {
  const m = read(RUNS.orphanImpl, `bulk-h${h}`)
  const w = read(RUNS.orphanImpl, `bulk-h${h}-wheel-wheel`)
  row(`K1ⓐ 창 rect 뷰포트 안 · h${h}`, m.modalInViewport, `vp ${m.vp.h} · modal ${m.modal.top}–${m.modal.bottom}`)
  row(`K1ⓑ 제목·✕·취소·확인 elementFromPoint · h${h}`, hits4(m), hitText(m))
  row(`K1ⓒ 스크롤 영역 넘침 + 실제 휠로 마지막 행 · h${h}`, m.scroll.scrollHeight > m.scroll.clientHeight && w.after.scrollTop > w.before.scrollTop && w.after.lastVisible === true,
    `scrollHeight ${m.scroll.scrollHeight} > clientHeight ${m.scroll.clientHeight} · CDP mouseWheel ${w.wheels}회 scrollTop ${w.before.scrollTop}→${w.after.scrollTop} · 마지막 행 ${w.before.lastVisible}→${w.after.lastVisible}`)
}
{
  const c = read(RUNS.orphanImpl, 'bulk-confirm')
  row('K1ⓓ h800 확인 클릭 → 카드 밖 0줄 + herdr workspace.list', c.orphanRowsAfter === 0 && c.herdrWorkspacesAfter === 0 && c.herdrL693Left === 0,
    `확인 전 줄 ${c.rowsBefore.labels}(코드 ${c.rowsBefore.code}) · 뒤 카드 밖 ${c.orphanRowsAfter}줄 · herdr workspace ${c.herdrWorkspacesAfter}개`)
}
// K4 — 기준 빌드 같은 장면
for (const h of [800, 600]) {
  const m = read(RUNS.orphanBase, `bulk-h${h}`)
  const w = read(RUNS.orphanBase, `bulk-h${h}-wheel-wheel`)
  row(`K4 기준 빌드 확인 버튼 hit 아님/뷰포트 밖 · h${h}`, !m.ok.hit, `${hitText(m)} · modal ${m.modal.top}–${m.modal.bottom} (vp ${m.vp.h}) · 휠 ${w.wheels}회 scrollTop ${w.before.scrollTop}→${w.after.scrollTop}`)
}
// K3ⓐ — 탭 여럿 닫기(App 경로) 넘침 600
{
  const m = read(RUNS.tabsImpl, 'tabs-h600')
  const w = read(RUNS.tabsImpl, 'tabs-h600-wheel-wheel')
  row('K3ⓐ 「다른 탭 닫기」 19줄 h600 — K1ⓐ', m.modalInViewport, `modal ${m.modal.top}–${m.modal.bottom} (vp ${m.vp.h}) · 줄 ${m.rows.labels}`)
  row('K3ⓐ 「다른 탭 닫기」 19줄 h600 — K1ⓑ', hits4(m), hitText(m))
  row('K3ⓐ (참고) 휠로 마지막 행', null, `scroll ${m.scroll.scrollHeight}/${m.scroll.clientHeight} · 휠 ${w.wheels}회 ${w.before.scrollTop}→${w.after.scrollTop} · 마지막 행 ${w.after.lastVisible}`)
}
// K3ⓑ — 키보드
{
  const k = read(RUNS.tabsImpl, 'k3b')
  row('K3ⓑ 열림 직후 포커스 = 취소', k.focusAtOpen?.cancel === true && k.reopenFocus?.cancel === true, `1차 ${JSON.stringify(k.focusAtOpen)} · 재열림 ${JSON.stringify(k.reopenFocus)}`)
  row('K3ⓑ Esc = 취소(창 닫힘, 탭 그대로)', k.closedByEsc === true && k.tabsAfterEsc === 20, `닫힘 ${k.closedByEsc} · 탭 ${k.tabsAfterEsc}`)
  row('K3ⓑ Tab → 확인', k.afterTab?.ok === true, JSON.stringify(k.afterTab))
  row('K3ⓑ Shift+Tab → 체크박스 노출(스크롤 따라감)', k.afterShiftTab2?.checkbox === true && k.checkboxVisibleAfterShiftTab2 === true && k.scrollTopAfterShiftTab2 > k.reopenScrollTop,
    `Shift+Tab 1 → ${JSON.stringify(k.afterShiftTab1)} · 2 → ${JSON.stringify(k.afterShiftTab2)} · scrollTop ${k.reopenScrollTop}→${k.scrollTopAfterShiftTab2} · 체크박스 보임 ${k.reopenCheckboxVisible}→${k.checkboxVisibleAfterShiftTab2}`)
}
// K2 — 짧은 내용, 같은 장면·같은 창 크기에서 수정 vs 기준 rect ±1px, 수정 빌드 스크롤 없음
const k2 = (label, implRun, baseRun, tag) => {
  const a = read(implRun, tag)
  const b = read(baseRun, tag)
  const d = ['top', 'bottom', 'left', 'right', 'width', 'height'].map((key) => Math.abs(a.modal[key] - b.modal[key]))
  const within = d.every((x) => x <= 1)
  const noScroll = a.scroll.scrollHeight === a.scroll.clientHeight
  return { a, b, within, noScroll, text: `수정 ${a.modal.width}×${a.modal.height} @${a.modal.top} · 기준 ${b.modal.width}×${b.modal.height} @${b.modal.top} · 최대 차 ${Math.max(...d).toFixed(2)}px · 수정 scroll ${a.scroll.scrollHeight}/${a.scroll.clientHeight}` }
}
for (const h of [800, 600]) {
  const box = k2('box', RUNS.tabsImpl, RUNS.tabsBase, `short-box-h${h}`)
  row(`K2 체크박스 있음(탭 1개 닫기) · h${h}`, box.within && box.noScroll, box.text)
  const nobox = k2('nobox', RUNS.orphanImpl, RUNS.orphanBase, `short-nobox-h${h}`)
  row(`K2 체크박스 없음(카드 밖 1줄 닫기) · h${h}`, nobox.within && nobox.noScroll, nobox.text)
}
// 판정 A·B — 수치만
{
  const a = k2('A', RUNS.tabsImpl, RUNS.tabsBase, 'short-box-h300')
  row('판정 A 관찰 · 짧은 내용 체크박스 있음 h300', null, `${a.text} · 수정 체크박스 보임 ${a.a.checkbox?.visible} / 기준 ${a.b.checkbox?.visible} · 수정 hits ${hitText(a.a)}`)
}
{
  const m = read(RUNS.orphanImpl, 'bulk-h160')
  const w = read(RUNS.orphanImpl, 'bulk-h160-wheel-wheel')
  const below = ['cancel', 'ok'].map((k) => `${k} y=${m[k].y}`).join(' · ')
  row('판정 B 관찰 · 넘침 h160', null, `vp ${m.vp.h} · modal ${m.modal.top}–${m.modal.bottom}(높이 ${m.modal.height}) · ${hitText(m)} · ${below} · scroll ${m.scroll.scrollHeight}/${m.scroll.clientHeight} · 휠 ${w.wheels}회 ${w.before.scrollTop}→${w.after.scrollTop}(최대 ${m.scroll.scrollHeight - m.scroll.clientHeight}) · 마지막 행 ${w.after.lastVisible}`)
}
// 격리 — 측정 중 창 포커스 (run.sh 의 측정 수 칸은 경로의 'confirm' 때문에 0 으로 잘못 셌다 — 여기서 JSON 으로 다시 센다)
for (const run of Object.values(RUNS)) {
  const files = fs.readdirSync(path.join(G1, run)).filter((f) => f.endsWith('.json'))
  const ms = files.map((f) => JSON.parse(fs.readFileSync(path.join(G1, run, f), 'utf8'))).filter((j) => 'windowFocused' in j)
  row(`격리 · ${run} 측정 중 창 포커스 없음`, ms.every((j) => j.windowFocused === false), `windowFocused=true ${ms.filter((j) => j.windowFocused === true).length} / 측정 ${ms.length} · document.hasFocus()=true ${ms.filter((j) => j.hasFocus === true).length}`)
}

console.log('\n| 항목 | 결과 | 근거 |\n| --- | --- | --- |')
for (const r of rows) console.log(`| ${r.item} | ${r.verdict} | ${r.detail.replaceAll('|', '/')} |`)
const failed = rows.filter((r) => r.verdict === '미달')
console.log(`\n# 통과 ${rows.filter((r) => r.verdict === '통과').length} · 미달 ${failed.length} · 기록 ${rows.filter((r) => r.verdict === '기록').length}`)
process.exit(failed.length === 0 ? 0 : 1)
