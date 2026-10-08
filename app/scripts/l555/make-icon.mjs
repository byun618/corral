// ⚠ 2026-10-08 폐기 — 사용자 제작 정식 아이콘으로 교체됨(`build/icon.png` = corral-icon-1024.png, 원본 SVG `build/brand/`). 다시 돌리면 정식 아이콘을 덮어쓴다.
// 임시 앱 아이콘 생성기 (LIFE-555 — 정식 아이콘은 범위 밖). 1024×1024 PNG 를 `build/icon.png` 로 쓴다.
// electron-builder 가 이 PNG 에서 `.icns` 를 만든다. 모양: 둥근 사각형 바탕 + 울타리(corral) 가로대 2줄·말뚝 4개.
// 실행: node scripts/l555/make-icon.mjs  (외부 의존성 없음 — zlib 로 직접 인코딩)
import fs from 'node:fs'
import zlib from 'node:zlib'

const SIZE = 1024
const BG = [0x1f, 0x3a, 0x34], FG = [0xe8, 0xd9, 0xb0]
const inRoundRect = (x, y, inset, radius) => {
  const lo = inset, hi = SIZE - inset
  if (x < lo || x >= hi || y < lo || y >= hi) return false
  const cx = Math.min(Math.max(x, lo + radius), hi - radius), cy = Math.min(Math.max(y, lo + radius), hi - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}
const inFence = (x, y) => {
  const rail = (y >= 400 && y < 450) || (y >= 600 && y < 650)
  const posts = [250, 410, 570, 730].some(px => x >= px && x < px + 50) && y >= 300 && y < 760
  return (rail && x >= 230 && x < 800) || posts
}
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1)
  raw[row] = 0
  for (let x = 0; x < SIZE; x++) {
    const at = row + 1 + x * 4
    const visible = inRoundRect(x, y, 100, 180)
    const color = inFence(x, y) ? FG : BG
    raw[at] = color[0]; raw[at + 1] = color[1]; raw[at + 2] = color[2]; raw[at + 3] = visible ? 255 : 0
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
fs.writeFileSync(new URL('../../build/icon.png', import.meta.url), png)
console.log(`build/icon.png ${png.length} bytes`)
