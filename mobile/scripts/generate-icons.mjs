// 안드로이드 적응형 아이콘 PNG 를 데스크톱 원본 svg 에서 만든다 (LIFE-596).
// 원본: app/build/brand/corral-icon-fullbleed.svg — 그라데이션 stop 과 올가미 경로·선 폭·색을 그대로 읽는다.
// 의존성 없음(node 내장 fs·zlib) — 다시 돌리면 같은 바이트가 나온다.
//   node scripts/generate-icons.mjs        (mobile/ 에서)
//
// 산출물 (assets/icon/, 1024×1024 RGBA):
//   adaptive-foreground.png — 흰 올가미 + 투명 배경. 불투명 픽셀 전부가 안전 원(지름 66/108) 안
//   adaptive-monochrome.png — 같은 올가미, 순백 (테마 아이콘은 알파만 쓴다)
//   adaptive-background.png — 데스크톱 세로 그라데이션. 마스크가 보여 주는 가운데 72/108 에 원본 그라데이션 전체를 맞춘다
// 데스크톱 svg 의 둥근 사각형·가장자리 흰 테두리 선은 옮기지 않는다 — 모양은 런처 마스크가 만든다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, '../../app/build/brand/corral-icon-fullbleed.svg')
const OUT_DIR = join(here, '../assets/icon')
const SIZE = 1024
// 안전 원 반지름 = 66/108 ÷ 2 × 폭 (0.3056). 안티앨리어싱 반 픽셀과 여유를 두고 0.30 에 맞춘다.
const LASSO_RADIUS = 0.3 * SIZE
// 적응형 레이어 108dp 중 마스크가 보여 주는 가운데 72dp.
const VISIBLE = 72 / 108

const svg = readFileSync(SOURCE, 'utf8')
const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
if (!viewBox || viewBox[1] !== viewBox[2]) throw new Error('정사각 viewBox 를 찾지 못했다')
const VIEW = Number(viewBox[1])

const stops = [...svg.match(/<linearGradient id="bg"[^>]*>([\s\S]*?)<\/linearGradient>/)[1].matchAll(
  /<stop offset="([\d.]+)" stop-color="#([0-9a-f]{6})"/g,
)].map((m) => ({ offset: Number(m[1]), rgb: [0, 2, 4].map((i) => parseInt(m[2].slice(i, i + 2), 16)) }))
if (stops.length < 2) throw new Error('그라데이션 stop 을 찾지 못했다')

const pathTag = svg.match(/<path [^>]*>/)[0]
const attr = (name) => {
  const m = pathTag.match(new RegExp(`${name}="([^"]+)"`))
  if (!m) throw new Error(`path ${name} 없음`)
  return m[1]
}
const strokeWidth = Number(attr('stroke-width'))
const strokeRgb = [0, 2, 4].map((i) => parseInt(attr('stroke').slice(1 + i, 3 + i), 16))

// 경로는 절대 좌표 M 하나 + C 들만 지원한다 (원본이 그 모양이다). 다른 명령이 오면 멈춘다.
function flatten(d) {
  const tokens = d.match(/[A-Za-z]|-?[\d.]+/g)
  const points = []
  let i = 0
  let cur = null
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') {
      cur = [num(), num()]
      points.push(cur)
    } else if (cmd === 'C') {
      while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
        const p1 = [num(), num()]
        const p2 = [num(), num()]
        const p3 = [num(), num()]
        const p0 = cur
        const steps = 128
        for (let s = 1; s <= steps; s++) {
          const t = s / steps
          const u = 1 - t
          const a = u * u * u
          const b = 3 * u * u * t
          const c = 3 * u * t * t
          const e = t * t * t
          points.push([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]])
        }
        cur = p3
      }
    } else {
      throw new Error(`지원하지 않는 경로 명령: ${cmd}`)
    }
  }
  return points
}

// 원본 구도를 지킨다: svg 중심 → 캔버스 중심, 선(반 폭 포함)의 중심 최대 거리 → LASSO_RADIUS.
const svgPoints = flatten(attr('d'))
const half = VIEW / 2
const reach = Math.max(...svgPoints.map(([x, y]) => Math.hypot(x - half, y - half))) + strokeWidth / 2
const scale = LASSO_RADIUS / reach
const points = svgPoints.map(([x, y]) => [SIZE / 2 + (x - half) * scale, SIZE / 2 + (y - half) * scale])
const halfStroke = (strokeWidth / 2) * scale

function distanceToPolyline(px, py) {
  let best = Infinity
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1]
    const [bx, by] = points[k]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) best = d
  }
  return best
}

// 선 = 폴리라인까지 거리 ≤ 반 폭 (둥근 끝·둥근 이음). 경계는 픽셀 중심 거리로 1px 선형 안티앨리어싱.
function renderLasso(rgb) {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const pad = halfStroke + 2
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
  const x1 = Math.min(SIZE - 1, Math.ceil(Math.max(...xs) + pad))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
  const y1 = Math.min(SIZE - 1, Math.ceil(Math.max(...ys) + pad))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const coverage = Math.max(0, Math.min(1, halfStroke + 0.5 - distanceToPolyline(x + 0.5, y + 0.5)))
      if (coverage === 0) continue
      const o = (y * SIZE + x) * 4
      data[o] = rgb[0]
      data[o + 1] = rgb[1]
      data[o + 2] = rgb[2]
      data[o + 3] = Math.round(coverage * 255)
    }
  }
  return data
}

function gradientAt(t) {
  if (t <= stops[0].offset) return stops[0].rgb
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1]
    const b = stops[k]
    if (t <= b.offset) {
      const f = (t - a.offset) / (b.offset - a.offset)
      return a.rgb.map((v, c) => Math.round(v + (b.rgb[c] - v) * f))
    }
  }
  return stops[stops.length - 1].rgb
}

function renderBackground() {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const top = (SIZE * (1 - VISIBLE)) / 2
  const span = SIZE * VISIBLE
  for (let y = 0; y < SIZE; y++) {
    const rgb = gradientAt((y + 0.5 - top) / span)
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4
      data[o] = rgb[0]
      data[o + 1] = rgb[1]
      data[o + 2] = rgb[2]
      data[o + 3] = 255
    }
  }
  return data
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, body) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(typed))
  return Buffer.concat([head, typed, tail])
}
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // 비트 깊이
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
const outputs = {
  'adaptive-foreground.png': renderLasso(strokeRgb),
  'adaptive-monochrome.png': renderLasso([255, 255, 255]),
  'adaptive-background.png': renderBackground(),
}
for (const [name, rgba] of Object.entries(outputs)) {
  writeFileSync(join(OUT_DIR, name), encodePng(rgba))
  console.log(`assets/icon/${name}`)
}
console.log(`scale ${scale.toFixed(4)} px/unit · lasso reach ${(LASSO_RADIUS / SIZE).toFixed(4)} × 폭`)
