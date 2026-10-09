// LIFE-576 K6 os-drag.sh 보조 — geo: 끄는 카드·놓을 자리의 화면 좌표(창 screenX/Y + 제목줄 + client) 와 bounds 안 여부. verify: ui-prefs 순서.
import fs from 'node:fs'
import path from 'node:path'
import * as l from './lib.mjs'
const [mode, out] = process.argv.slice(2)
const M = '/Users/byun/repos/byun618/corral'
/** 끄는 카드 = corral 구획 마지막 루트 덩어리(자식 없음) — 맨 위 덩어리 윗변으로 옮긴다. 1회차는 이미 맨 위인 카드를 골라 제자리였다. */
if (mode === 'geo') {
  const cards = await l.cards()
  const units = cards.filter((card) => card.owner === null && card.section === M)
  const childless = units.filter((unit) => !cards.some((card) => card.owner === unit.path))
  const source = childless.at(-1)
  // OS 입력이 렌더러에 닿았는지 — 페이지 안 계수기(캡처 단계 리스너, 읽기 전용).
  await l.evalJs(`(() => { window.__l576os = { down: 0, move: 0, up: 0 }; for (const t of ['mousedown', 'mousemove', 'mouseup']) document.addEventListener(t, () => { window.__l576os[t.slice(5)]++ }, true); return true })()`)
  const g = await l.evalJs('({ sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight, ih: window.innerHeight })')
  const bar = g.oh - g.ih
  const sx = Math.round(g.sx + source.left + 60), sy = Math.round(g.sy + bar + source.contentTop + 14)
  const tx = sx, ty = Math.round(g.sy + bar + units[0].top + 2)
  const inside = [sy, ty].every((y) => y > g.sy + bar && y < g.sy + g.oh) && sx > g.sx && sx < g.sx + g.ow
  fs.writeFileSync(path.join(out, 'os-drag-before.json'), JSON.stringify({ source: source.path, order: l.prefs().manualWorktreeOrder[M], first: units[0].path, sourceTop: source.top, window: g }, null, 2))
  console.log([sx, sy, tx, ty, inside ? 1 : 0].join(' '))
} else {
  await l.pause(1500)
  const order = l.prefs().manualWorktreeOrder[M]
  const before = JSON.parse(fs.readFileSync(path.join(out, 'os-drag-before.json'), 'utf8'))
  const cards = await l.cards()
  const first = cards.filter((card) => card.owner === null && card.section === M)[0]?.path
  const X = before.source
  const events = await l.evalJs('window.__l576os ?? null')
  const pass = before.order[0] !== X && order[0] === X && first === X
  fs.writeFileSync(path.join(out, 'os-drag-verify.json'), JSON.stringify({ pass, source: X, events, beforeFirst: before.first, afterFirst: first, orderBefore: before.order, orderAfter: order }, null, 2))
  console.log(pass ? 'PASS K6-os-drag' : 'FAIL K6-os-drag', JSON.stringify({ source: X, events, beforeFirst: before.first, afterFirst: first }))
  process.exit(pass ? 0 : 1)
}
