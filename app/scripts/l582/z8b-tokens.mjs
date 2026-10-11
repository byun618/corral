// LIFE-582 최종 관문 Z8ⓑ — 582 가 새로 그린 요소(중단 버튼·입력창 보내기·실패 말풍선·질문/승인 카드)의 캡처 색·크기를
// `specs/design-tokens-mobile.css` 값과 대조한다. 측정 방식은 LIFE-581 `l581/y6c-tokens.mjs` 와 같다(색 ±3, 크기 ±1dp, 1dp = 2.625px).
//   check <screens dir> <out.json> — 종료 코드 0 통과 · 1 미달
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

function modeColor(png, x, y) {
  const counts = new Map()
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = hex(at(png, x + dx, y + dy)); counts.set(c, (counts.get(c) ?? 0) + 1) }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}
function saturatedTop(png, [x0, y0, x1, y1]) {
  const counts = new Map()
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = at(png, x, y)
    if (Math.max(...c) - Math.min(...c) < 60) continue
    const h = hex(c); counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)
}
/** 세로줄 x 에서 y0..y1 사이 `color`(±3) 가 처음·마지막으로 나온 행 사이 높이(px) — 테두리처럼 위아래로 갈린 색도 상자 높이로 잰다. */
function spanHeight(png, x, y0, y1, color) {
  let top = null, bottom = null
  for (let y = y0; y <= y1; y++) if (near(at(png, x, y), parse(color))) { top ??= y; bottom = y }
  return top === null ? 0 : bottom - top + 1
}

const errorTint50 = over({ rgb: parse('#e06c5f'), alpha: 0.5 })
// 좌표는 1080×2400 캡처 기준(y6c probe 로 고름). 높이는 요소 가운데 세로줄에서 잰다(둥근 끝에서 재면 짧게 나온다).
const SPEC = [
  { file: 's17-c7-armed.png', what: 'StopButton 장전 바탕', token: '--st-error', expect: '#e06c5f', x: 885, y: 207 },
  { file: 's17-c7-armed.png', what: 'StopButton 높이', token: 'StopButton 40', expectDp: 40, x: 885, y0: 120, y1: 300, span: '#e06c5f' },
  { file: 's55-c6-permission-cp.png', what: 'StopButton 기본 테두리(st-error 50%)', token: '--st-error 50%', expectDp: 40, x: 885, y0: 120, y1: 300, span: errorTint50 },
  { file: 's55-c6-permission-cp.png', what: 'StopButton 기본 글자', token: '--st-error', expectSat: '#e06c5f', rect: [740, 160, 1040, 250] },
  { file: 's55-c6-permission-cp.png', what: '승인 대기 SystemNote 점', token: '--agent-dot-question', expectSat: '#ff6900', rect: [60, 1840, 140, 1920] },
  { file: 's55-c6-permission-cp.png', what: '입력창 보내기(잠김) 바탕', token: '--bg-chip', expect: '#262626', x: 988, y: 2100 },
  { file: 's55-c6-permission-cp.png', what: '입력창 보내기 지름', token: 'Composer 46', expectDp: 46, x: 988, y0: 2030, y1: 2240, span: '#262626' },
  { file: 's55-c6-permission-cp.png', what: '입력창 바탕', token: '--bg-window', expect: '#171717', x: 500, y: 2128 },
  { file: 's50-z4c-typed-in-question.png', what: '입력창 보내기(열림) 바탕', token: '--fg', expect: '#fafafa', x: 960, y: 2100 },
  { file: 's50-z4c-typed-in-question.png', what: '질문 카드 머리 글자', token: '--agent-dot-question', expectSat: '#ff6900', rect: [60, 1300, 300, 1370] },
  { file: 's44-c12-nochat-failed-retry.png', what: '실패 말풍선 테두리', token: '--st-error', expect: '#e06c5f', x: 900, y: 1741 },
  { file: 's44-c12-nochat-failed-retry.png', what: '실패 말풍선 바탕', token: '--bg-chip', expect: '#262626', x: 900, y: 1800 },
  { file: 's44-c12-nochat-failed-retry.png', what: '실패 사유 글자', token: '--st-error', expectSat: '#e06c5f', rect: [160, 1880, 860, 2000] },
]

function check(dir, out) {
  const rows = SPEC.map((spec) => {
    const png = read(path.join(dir, spec.file))
    if (spec.expectSat !== undefined) {
      const top = saturatedTop(png, spec.rect)
      return { ...spec, measured: top.map(([c, n]) => `${c}×${n}`).join(' '), pass: top.some(([c]) => near(parse(c), parse(spec.expectSat))) }
    }
    if (spec.span !== undefined) {
      const px = spanHeight(png, spec.x, spec.y0, spec.y1, spec.span)
      const dp = px / DP
      return { ...spec, measuredPx: px, measuredDp: Number(dp.toFixed(2)), pass: Math.abs(dp - spec.expectDp) <= 1 }
    }
    const got = modeColor(png, spec.x, spec.y)
    return { ...spec, measured: got, pass: near(parse(got), parse(spec.expect)) }
  })
  const pass = rows.every((row) => row.pass !== false)
  fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), density: 420, dpPx: DP, pass, rows }, null, 2))
  for (const row of rows) console.log(`${row.pass ? '통과' : '미달'} ${row.file} ${row.what}: ${row.measured ?? row.measuredDp + 'dp'} (기대 ${row.expect ?? row.expectSat ?? row.expectDp + 'dp'} · ${row.token})`)
  process.exit(pass ? 0 : 1)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'check') check(...rest)
else { console.error('명령: check <screens dir> <out.json>'); process.exit(2) }
