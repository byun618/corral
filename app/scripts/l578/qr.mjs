// 페어링 페이로드 파일(비밀, 0600) → QR PNG(비밀, 0600). 에뮬레이터 가상 장면 벽 포스터(`adb emu virtualscene-image wall <png>`)로 카메라 스캔을 돌린다.
// 사용: node qr.mjs <페이로드 파일> <png 파일>. 둘 다 /tmp 에만 두고 커밋하지 않는다(G5).
import fs from 'node:fs'
import { createRequire } from 'node:module'
const QRCode = createRequire(import.meta.url)('qrcode')
const [input, output] = process.argv.slice(2)
await QRCode.toFile(output, fs.readFileSync(input, 'utf8'), { errorCorrectionLevel: 'M', margin: 4, width: 1024 })
fs.chmodSync(output, 0o600)
console.log(JSON.stringify({ at: Date.now(), qr: output }))
