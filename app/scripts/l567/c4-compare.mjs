// LIFE-567 최종 관문 C4 — c4.mjs 결과 두 개(수정 전·후)를 항목별로 나란히 대조해 표 데이터를 찍는다. 판정 규칙:
//   ⓐ commit 회차: 보낸 바이트 = ['한'] 이고 커서 줄의 '한' 개수 = 1 (두 빌드 모두)
//   ⓑ Return·Escape·Backspace 회차: 보낸 바이트·커서 줄·Return 뒤 바이트가 두 빌드에서 같다
//   ⓒ 휠: 위로 10줄·아래로 원위치 결과가 같고 원위치 복귀 / 선택: 기대 문자열과 같다(두 빌드) / 링크: ⌘+클릭으로 URL 이 정확히 1번 열림(두 빌드)
//   ⓓ 분할·축소·확대·닫기 뒤 모든 pane: baseY 0 = viewportY, DOM 행 = 버퍼 표시 행(불일치 0), pane 수 기대대로
// 사용: node c4-compare.mjs <base.json> <fix.json>  → 표준출력 JSON, 하나라도 미달이면 exit 1
import fs from 'node:fs'
const [baseFile, fixFile] = process.argv.slice(2)
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8')), fix = JSON.parse(fs.readFileSync(fixFile, 'utf8'))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const out = { failures: { base: base.failure ?? null, fix: fix.failure ?? null } }
const commit = (r) => r.typing.filter((t) => t.mode === 'commit')
out.a = { n: [commit(base).length, commit(fix).length],
  base: commit(base).map((t) => ({ sent: t.sent, han: t.hanCountOnLine })), fix: commit(fix).map((t) => ({ sent: t.sent, han: t.hanCountOnLine })),
  pass: [base, fix].every((r) => commit(r).length === 3 && commit(r).every((t) => same(t.sent, ['한']) && t.hanCountOnLine === 1)) }
const keyed = (r) => r.typing.filter((t) => t.mode !== 'commit').map((t) => ({ mode: t.mode, r: t.r, sent: t.sent, cursorLine: t.cursorLine, afterReturn: t.afterReturn }))
out.b = { n: [keyed(base).length, keyed(fix).length], base: keyed(base), pass: keyed(base).length === 9 && same(keyed(base), keyed(fix)), diff: keyed(base).map((x, i) => same(x, keyed(fix)[i]) ? null : { base: x, fix: keyed(fix)[i] }).filter(Boolean) }
const w = (r) => r.wheel.map((x) => ({ up: x.topAfterUp, back: x.backToBottom, before: x.topBefore }))
out.c_wheel = { base: w(base), fix: w(fix), pass: w(base).length === 3 && same(w(base), w(fix)) && w(fix).every((x) => x.back && x.up !== x.before) }
const sel = (r) => r.selection.map((x) => ({ phase: x.phase, ok: x.equalsExpected, len: x.text.length }))
out.c_select = { base: sel(base), fix: sel(fix), pass: sel(base).length === 6 && sel(fix).length === 6 && [...sel(base), ...sel(fix)].every((x) => x.ok) }
const lk = (r) => r.links.map((x) => ({ phase: x.phase, opened: x.opened }))
out.c_link = { base: lk(base), fix: lk(fix), pass: lk(base).length === 6 && lk(fix).length === 6 && [...lk(base), ...lk(fix)].every((x) => same(x.opened, ['https://example.com/l567-link'])) }
const lay = (r) => r.layout.map((x) => ({ label: x.label, panes: x.panes.length, ok: x.panes.every((p) => p.baseY === 0 && p.viewportY === 0 && p.mismatches === 0), detail: x.panes.map((p) => [p.cols, p.rows, p.baseY, p.viewportY, p.mismatches]) }))
out.d = { base: lay(base), fix: lay(fix), passFix: lay(fix).length === 12 && lay(fix).every((x) => x.ok), baseAllOk: lay(base).every((x) => x.ok) }
out.pass = !base.failure && !fix.failure && out.a.pass && out.b.pass && out.c_wheel.pass && out.c_select.pass && out.c_link.pass && out.d.passFix
console.log(JSON.stringify(out, null, 1))
process.exit(out.pass ? 0 : 1)
