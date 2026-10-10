// LIFE-581 Y6ⓒ — 캡처 PNG 의 색·크기를 `specs/design-tokens-mobile.css`(= `mobile/src/ui/tokens.ts`) 값과 대조한다.
//   probe  <png> <x> <y0> <y1>   — 세로 한 줄(x)의 색 구간(run)을 찍는다(좌표 고르기용)
//   check  <screens dir> <out.json> — 아래 SPEC 을 돌려 판정(색: 채널마다 ±3, 크기: ±1dp). 종료 코드 0 통과 · 1 미달
// 밀도: 에뮬레이터 `wm density` 420 → 1dp = 2.625px. 반투명 토큰은 surface(#0a0a0a) 위에 합성한 값으로 대조한다.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const { PNG } = createRequire(path.join(process.cwd(), 'package.json'))('pngjs')
const DP = 420 / 160
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const parse = (text) => [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16))
const over = ({ rgb, alpha, base = '#0a0a0a' }) => hex(rgb.map((v, i) => v * alpha + parse(base)[i] * (1 - alpha)))
const read = (file) => PNG.sync.read(fs.readFileSync(file))
const at = (png, x, y) => { const i = (png.width * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2]] }
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

/** (x,y) 둘레 5×5 의 최빈 색. */
function modeColor(png, x, y) {
  const counts = new Map()
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = hex(at(png, x + dx, y + dy)); counts.set(c, (counts.get(c) ?? 0) + 1) }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

/** 사각형 안에서 채도 있는 픽셀(최대−최소 ≥ 60)의 최빈 색 3개 — 글자·점처럼 작은 색 칠을 본다. */
function saturatedTop(png, [x0, y0, x1, y1]) {
  const counts = new Map()
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = at(png, x, y)
    if (Math.max(...c) - Math.min(...c) < 60) continue
    const h = hex(c); counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)
}

/** 사각형 안에서 `color`(±3) 픽셀이 하나라도 있는 행의 첫·끝 사이 높이(px) — 모서리 둥글림·글자에 안 흔들리는 상자 높이. */
function boxHeight(png, [x0, y0, x1, y1], color) {
  let top = null, bottom = null
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (near(at(png, x, y), parse(color))) { top ??= y; bottom = y; break }
  return top === null ? 0 : bottom - top + 1
}

/** 세로줄 x 에서 y0..y1 사이 색이 `color`(±3)인 가장 긴 연속 구간 — 높이(px). */
function runHeight(png, x, y0, y1, color) {
  let best = 0, cur = 0
  for (let y = y0; y <= y1; y++) { if (near(at(png, x, y), parse(color))) { cur += 1; best = Math.max(best, cur) } else cur = 0 }
  return best
}

// 좌표는 1080×2400 캡처 기준(probe 로 고름). expect 는 토큰 이름 = 값.
const SPEC = [
  { file: 'y5d-after-reconnect.png', what: '화면 바탕', token: '--bg-surface', expect: '#0a0a0a', x: 540, y: 1700 },
  { file: 'y5d-after-reconnect.png', what: '지시 말풍선 바탕', token: '--bg-chip', expect: '#262626', x: 600, y: 588 },
  { file: 'y5d-after-reconnect.png', what: '지시 말풍선 높이(한 줄 = 패딩 10·10 + 줄 22.5)', token: '--m-fs-body 15 · --m-lh-body 1.5(22.5) · pad 10', expectDp: 42.5, rect: [591, 500, 1040, 700], box: '#262626' },
  { file: 'c10-watching-band.png', what: '도구 묶음 카드 바탕', token: '--m-tool-card-bg = --bg-window', expect: '#171717', x: 900, y: 2037 },
  // 관찰(판정 밖): 대화 본문 좌우 여백 — 이를 정하는 토큰이 없다(--m-pad-x 18 은 목록·띠, 목업 conversation.dc.html 89행은 14, 제품은 16). 첫 회차(T0)는 18 로 판정해 미달이었다 — 기준 결함.
  { file: 'y5d-after-reconnect.png', what: '지시 말풍선 오른쪽 여백(관찰)', token: '토큰 없음 — 목업 14 · --m-pad-x 18', expectDp: null, info: true, rightGap: { y: 612, color: '#262626' } },
  { file: 'c10-watching-band.png', what: '도구 묶음 카드 안 높이', token: 'ToolGroup 머리 42', expectDp: 42, x: 900, y0: 1960, y1: 2110, run: '#171717' },
  { file: 'c10-watching-band.png', what: '지켜보는 중 띠 바탕(accent 8%)', token: '--accent 8%', expect: over({ rgb: parse('#7dd3a0'), alpha: 0.08 }), x: 900, y: 384 },
  { file: 'c10-watching-band.png', what: '지켜보는 중 띠 높이', token: '띠 30', expectDp: 30, x: 900, y0: 300, y1: 460, run: over({ rgb: parse('#7dd3a0'), alpha: 0.08 }) },
  { file: 'c10-watching-band.png', what: '지켜보는 중 띠 글자', token: '--accent', expectSat: '#7dd3a0', rect: [0, 347, 1080, 425] },
  { file: 'c18-offline.png', what: '끊김 띠 바탕(st-error 12%)', token: '--st-error 12%', expect: over({ rgb: parse('#e06c5f'), alpha: 0.12 }), x: 1000, y: 400 },
  { file: 'c18-offline.png', what: '끊김 띠 높이', token: '--m-band-h 40', expectDp: 40, rect: [990, 280, 1010, 480], box: over({ rgb: parse('#e06c5f'), alpha: 0.12 }) },
  { file: 'c18-offline.png', what: '끊김 띠 점', token: '--st-error', expectSat: '#e06c5f', rect: [0, 347, 120, 451] },
  { file: 'c17-reconnecting-6s.png', what: '재연결 띠 바탕', token: '--bg-window', expect: '#171717', x: 1000, y: 400 },
  { file: 'c17-reconnecting-6s.png', what: '재연결 띠 높이', token: '--m-band-h 40', expectDp: 40, x: 1000, y0: 300, y1: 480, run: '#171717' },
  // SystemNote 제목은 상태색 — 중단됨·실패 = --agent-dot-alert(핸드오프 §1 78행 · §2 SystemNote). T0 는 --st-error 로 기대해 미달 — 기준 결함.
  { file: 'c09-failed.png', what: '실패 SystemNote 제목', token: '--agent-dot-alert', expectSat: '#fb2c36', rect: [0, 1200, 1080, 2300] },
  { file: 'c01-working.png', what: '작업 중 상태 글리프', token: '--agent-dot-working', expectSat: '#f0b100', rect: [0, 120, 1080, 330] },
]

function check(dir, out) {
  const rows = SPEC.map((spec) => {
    const png = read(path.join(dir, spec.file))
    if (spec.expectSat !== undefined) {
      const top = saturatedTop(png, spec.rect)
      return { ...spec, measured: top.map(([c, n]) => `${c}×${n}`).join(' '), pass: top.some(([c]) => near(parse(c), parse(spec.expectSat))) }
    }
    if (spec.rightGap !== undefined) {
      let x = png.width - 1
      while (x > 0 && !near(at(png, x, spec.rightGap.y), parse(spec.rightGap.color))) x -= 1
      const dp = (png.width - 1 - x) / DP
      return { ...spec, measuredPx: png.width - 1 - x, measuredDp: Number(dp.toFixed(2)), pass: spec.info === true ? null : Math.abs(dp - spec.expectDp) <= 1 }
    }
    if (spec.box !== undefined) {
      const px = boxHeight(png, spec.rect, spec.box)
      const dp = px / DP
      return { ...spec, measuredPx: px, measuredDp: Number(dp.toFixed(2)), pass: Math.abs(dp - spec.expectDp) <= 1 }
    }
    if (spec.run !== undefined) {
      const px = runHeight(png, spec.x, spec.y0, spec.y1, spec.run)
      const dp = px / DP
      return { ...spec, measuredPx: px, measuredDp: Number(dp.toFixed(2)), pass: Math.abs(dp - spec.expectDp) <= 1 }
    }
    const got = modeColor(png, spec.x, spec.y)
    return { ...spec, measured: got, pass: near(parse(got), parse(spec.expect)) }
  })
  const pass = rows.every((row) => row.pass !== false)
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), density: 420, dpPx: DP, pass, rows }, null, 2))
  for (const row of rows) console.log(`${row.pass === null ? '관찰' : row.pass ? '통과' : '미달'} ${row.file} ${row.what}: ${row.measured ?? row.measuredDp + 'dp'} (기대 ${row.expect ?? row.expectSat ?? (row.expectDp === null ? '—' : row.expectDp + 'dp')})`)
  process.exit(pass ? 0 : 1)
}

function probe(file, x, y0, y1) {
  const png = read(file)
  let start = +y0, prev = hex(at(png, +x, +y0))
  for (let y = +y0 + 1; y <= +y1 + 1; y++) {
    const c = y > +y1 ? null : hex(at(png, +x, y))
    if (c !== prev) { console.log(`${start}-${y - 1} (${y - start}px) ${prev}`); start = y; prev = c }
  }
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'check') check(...rest)
else if (cmd === 'probe') probe(...rest)
else { console.error('명령: probe <png> <x> <y0> <y1> · check <screens dir> <out.json>'); process.exit(2) }
