// LIFE-373 스파이크 — 프레임 픽스처 생성기 (throwaway).
//
// 앱 본체를 고치지 않는 대신, **본체가 실제로 쓰는 인코더**(벤더 frame-to-ansi.ts)에
// 합성 셀 격자를 먹여 프레임 바이트를 만든다. 에이전트 TUI 의 diff 없는 전체 리페인트가
// 대상이라 (00-analysis §4 ⓐ) 스타일 churn 을 많이 넣는다 — DOM 렌더 비용은
// [span 개수 × CSS 규칙] 이 지배한다 (xterm.js#4604).
//
// 결정적(seed 고정)이라 픽스처 자체는 커밋하지 않는다 — 이 파일 + 통계 + 샘플 1장만 커밋.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.dirname(path.dirname(path.dirname(HERE)))
const VENDOR = path.join(APP_DIR, 'src/main/adapter/internal/vendor/frame-to-ansi.ts')

/** 벤더 인코더를 esbuild 로 묶어 그대로 import 한다 (재작성 금지 — 본체와 같은 바이트여야 한다). */
export async function loadFrameToAnsi() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l373-')), 'frame-to-ansi.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    VENDOR,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${out}`,
  ])
  const mod = await import(out)
  return mod.frameToAnsi
}

// --- 결정적 난수 (mulberry32) -------------------------------------------------
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rgb = (r, g, b) => 0x02000000 | (r << 16) | (g << 8) | b
const MOD_BOLD = 0x0001
const MOD_DIM = 0x0002
const MOD_ITALIC = 0x0004

const BG = rgb(20, 23, 24) // --bg-surface 와 같은 계열
const PALETTE = [
  rgb(220, 223, 228), rgb(122, 198, 255), rgb(126, 231, 135), rgb(255, 199, 106),
  rgb(255, 128, 128), rgb(198, 160, 246), rgb(129, 200, 190), rgb(150, 155, 165),
]
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const WORDS = [
  'const', 'return', 'await', 'session', 'pane', 'frame', 'herdr', 'corral', 'render',
  'xterm', 'layout', 'stream', 'seq', 'bytes', 'cols', 'rows', 'focus', 'split', 'ratio',
  'Thinking', 'Reading', 'Editing', 'Running', 'tokens', 'src/main', 'adapter', 'vendor',
]

function blank() {
  return { symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null }
}

/**
 * 프레임 하나를 만든다. 에이전트 TUI 모양 — 박스 테두리 + 스피너 + 진행바 + 상태바 +
 * 색이 자주 바뀌는 본문. 프레임마다 스피너·타이머·본문이 한 줄씩 밀린다.
 */
function makeFrame({ cols, rows, tick, seed, avgRun }) {
  const rand = rng(seed + tick * 7919)
  const cells = new Array(cols * rows)
  for (let i = 0; i < cells.length; i++) cells[i] = blank()

  const put = (x, y, symbol, fg, bg, modifier) => {
    if (x < 0 || x >= cols || y < 0 || y >= rows) return
    cells[y * cols + x] = { symbol, fg, bg, modifier, skip: false, hyperlink: null }
  }
  const text = (x, y, s, fg, bg, modifier) => {
    for (let i = 0; i < s.length && x + i < cols; i++) put(x + i, y, s[i], fg, bg, modifier)
  }

  const border = rgb(78, 86, 94)
  // 테두리
  put(0, 0, '╭', border, BG, MOD_DIM)
  put(cols - 1, 0, '╮', border, BG, MOD_DIM)
  for (let x = 1; x < cols - 1; x++) put(x, 0, '─', border, BG, MOD_DIM)
  const boxBottom = rows - 3
  put(0, boxBottom, '╰', border, BG, MOD_DIM)
  put(cols - 1, boxBottom, '╯', border, BG, MOD_DIM)
  for (let x = 1; x < cols - 1; x++) put(x, boxBottom, '─', border, BG, MOD_DIM)
  for (let y = 1; y < boxBottom; y++) {
    put(0, y, '│', border, BG, MOD_DIM)
    put(cols - 1, y, '│', border, BG, MOD_DIM)
  }
  text(2, 0, ` corral · claude-opus · ${String(tick).padStart(5, '0')} `, PALETTE[1], BG, MOD_BOLD)

  // 본문 — 색 런이 자주 끊기는 줄들
  for (let y = 1; y < boxBottom; y++) {
    let x = 2
    const kind = (y + tick) % 6
    if (kind === 0) {
      // diff 줄 (배경색 있는 런)
      const added = ((y + tick) & 1) === 0
      const bg = added ? rgb(24, 56, 34) : rgb(62, 28, 30)
      const fg = added ? PALETTE[2] : PALETTE[4]
      text(x, y, added ? '+ ' : '- ', fg, bg, MOD_BOLD)
      x += 2
      while (x < cols - 2) {
        const w = WORDS[Math.floor(rand() * WORDS.length)]
        const run = w.slice(0, Math.max(2, Math.floor(rand() * avgRun * 2)))
        text(x, y, run + ' ', fg, bg, rand() < 0.25 ? MOD_ITALIC : 0)
        x += run.length + 1
      }
      continue
    }
    if (kind === 1) {
      text(x, y, `${SPINNER[(tick + y) % SPINNER.length]} `, PALETTE[3], BG, MOD_BOLD)
      x += 2
      text(x, y, `Thinking… (${(tick % 600) / 10}s · ↑ ${(tick * 37) % 9999} tokens)`, PALETTE[7], BG, MOD_DIM)
      continue
    }
    // 일반 본문 — 짧은 런마다 색·수식자 교체 (span 개수를 실물에 가깝게)
    while (x < cols - 2) {
      const len = Math.max(2, Math.round((rand() * 2 * avgRun) | 0))
      const w = WORDS[Math.floor(rand() * WORDS.length)]
      const run = (w + '................').slice(0, len)
      const fg = PALETTE[Math.floor(rand() * PALETTE.length)]
      const mod = rand() < 0.2 ? MOD_BOLD : rand() < 0.35 ? MOD_DIM : 0
      text(x, y, run, fg, BG, mod)
      x += run.length
      if (x < cols - 2) {
        put(x, y, ' ', PALETTE[0], BG, 0)
        x += 1
      }
    }
  }

  // 진행바
  const barY = rows - 2
  const filled = Math.floor(((tick % 40) / 40) * (cols - 20))
  text(1, barY, 'build ', PALETTE[7], BG, MOD_DIM)
  for (let i = 0; i < cols - 20; i++) {
    const on = i < filled
    put(7 + i, barY, on ? '█' : '░', on ? PALETTE[2] : rgb(60, 64, 70), BG, on ? MOD_BOLD : MOD_DIM)
  }
  text(cols - 12, barY, `${String(Math.floor(((tick % 40) / 40) * 100)).padStart(3)}%`, PALETTE[3], BG, MOD_BOLD)

  // 상태바 (reverse 대신 실제 배경색 — 셀 단위로 배경이 꽉 찬 줄)
  const statusY = rows - 1
  const sbg = rgb(38, 44, 52)
  for (let x = 0; x < cols; x++) put(x, statusY, ' ', PALETTE[0], sbg, 0)
  text(1, statusY, ` NORMAL `, rgb(20, 23, 24), PALETTE[1], MOD_BOLD)
  text(11, statusY, `pane ${tick % 8} · ${cols}×${rows} · seq ${tick}`, PALETTE[0], sbg, 0)
  text(cols - 18, statusY, `main ✚2 ⚑1 ↑3`, PALETTE[3], sbg, MOD_BOLD)

  return {
    cells,
    width: cols,
    height: rows,
    cursor: { x: (tick * 3) % cols, y: boxBottom - 1, visible: true, shape: 2 },
    hyperlinks: [],
  }
}

/** ANSI 프레임 배열을 만든다. stream.ts 와 같이 BSU/ESU 로 감싼다. */
export async function buildFrames({ cols, rows, count = 60, seed = 20260916, avgRun = 5 }) {
  const frameToAnsi = await loadFrameToAnsi()
  const out = []
  for (let tick = 0; tick < count; tick++) {
    const body = frameToAnsi(makeFrame({ cols, rows, tick, seed, avgRun }), { cols, rows })
    out.push('\x1b[?2026h' + body + '\x1b[?2026l')
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cols = Number(process.argv[2] ?? 100)
  const rows = Number(process.argv[3] ?? 30)
  const frames = await buildFrames({ cols, rows })
  const sizes = frames.map((f) => Buffer.byteLength(f, 'utf8'))
  console.log(JSON.stringify({
    cols, rows, count: frames.length,
    bytesMin: Math.min(...sizes), bytesMax: Math.max(...sizes),
    bytesAvg: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    bytesPerCell: +(sizes.reduce((a, b) => a + b, 0) / sizes.length / (cols * rows)).toFixed(2),
  }, null, 2))
}
