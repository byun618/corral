// LIFE-580 최종 관문 L11 — TTF name 표의 저작권(0)·라이선스(13)·라이선스 URL(14)을 찍는다(APK 안 글꼴이 OFL 고지를 메타데이터로 동반하는지). 사용: node scripts/l580/ttf-name.mjs <ttf>
import fs from 'node:fs'
// TTF name 표에서 nameID 0(저작권)·13(라이선스 설명)·14(라이선스 URL) 를 읽는다
const buf = fs.readFileSync(process.argv[2])
const n = buf.readUInt16BE(4)
let name = null
for (let i = 0; i < n; i++) { const o = 12 + i * 16; if (buf.toString('latin1', o, o + 4) === 'name') name = buf.readUInt32BE(o + 8) }
const count = buf.readUInt16BE(name + 2), str = name + buf.readUInt16BE(name + 4)
const out = {}
for (let i = 0; i < count; i++) {
  const r = name + 6 + i * 12
  const [pid, , , nid, len, off] = [0, 2, 4, 6, 8, 10].map((d) => buf.readUInt16BE(r + d))
  if (![0, 13, 14].includes(nid) || out[nid]) continue
  const raw = buf.subarray(str + off, str + off + len)
  out[nid] = (pid === 3 || pid === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1')).slice(0, 110)
}
console.log(process.argv[2].split('/').pop(), JSON.stringify(out))
