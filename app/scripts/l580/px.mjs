// LIFE-580 최종 관문 L5ⓕ — 캡처 PNG 의 (x,y) 둘레 ±r 에서 채도 있는 픽셀의 최빈 색 2개(상태 점 색을 디자인 토큰과 대조). 사용(app/): node scripts/l580/px.mjs <png> <x> <y> [r]
import fs from 'node:fs'
import { createRequire } from 'node:module'
const { PNG } = createRequire(process.cwd() + '/package.json')('pngjs')
const [file, cx, cy, r = 22] = process.argv.slice(2)
const png = PNG.sync.read(fs.readFileSync(file))
const counts = new Map()
for (let y = +cy - r; y <= +cy + r; y++) for (let x = +cx - r; x <= +cx + r; x++) {
  const i = (png.width * y + x) << 2
  const [R, G, B] = [png.data[i], png.data[i + 1], png.data[i + 2]]
  if (Math.max(R, G, B) - Math.min(R, G, B) < 60) continue
  const hex = '#' + [R, G, B].map((v) => v.toString(16).padStart(2, '0')).join('')
  counts.set(hex, (counts.get(hex) ?? 0) + 1)
}
console.log(JSON.stringify({ file: file.split('/').pop(), at: [+cx, +cy], top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2) }))
