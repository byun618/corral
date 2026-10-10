// LIFE-580 최종 관문 — 에뮬레이터 목록 화면 캡처 + **고정 띠 가림**(G5). l578 `emu.mjs shot` 은 uiautomator 덤프로 맥 이름 노드를 찾아 칠하는데,
// RN 화면이 바뀐 직후엔 덤프가 낡아 노드를 못 찾고 가림 0 으로 저장한 적이 있다(최종 관문 f22 — 맥 이름이 찍힌 캡처). 그래서 목록 화면의
// 앱 바 둘째 줄(`<맥> · 연결됨`) 자리를 **덤프와 무관하게 늘** 칠하고, 덤프가 찾은 비밀 노드도 덧칠한다.
// 사용: node shot.mjs <파일.png>            — 새 캡처(emulator-5554)
//       node shot.mjs --repaint <파일.png>  — 이미 찍은 캡처에 같은 띠만 칠한다(덤프 없음)
// 비밀 목록: L578_REDACT_FILE(줄마다 하나, 기본 /tmp/l580fg/sec/macname). 띠: 1080×2400 기준 x 20–1010 · y 212–282(앱 바 둘째 줄 전체 — 끊김일 땐 연결 점이 없어 이름이 왼쪽으로 붙는다, f30).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const SERIAL = 'emulator-5554'
const BAND = { x1: 20, x2: 1010, y1: 212, y2: 282 }
const adb = (args) => execFileSync('adb', ['-s', SERIAL, ...args], { maxBuffer: 64 * 1024 * 1024 })
const { PNG } = createRequire(import.meta.url)('pngjs')
const secrets = (() => {
  try {
    return fs.readFileSync(process.env.L578_REDACT_FILE ?? '/tmp/l580fg/sec/macname', 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
})()

function paint(png, box) {
  const sx = png.width / 1080
  const sy = png.height / 2400
  for (let y = Math.max(0, Math.round(box.y1 * sy)); y < Math.min(png.height, Math.round(box.y2 * sy)); y += 1) {
    for (let x = Math.max(0, Math.round(box.x1 * sx)); x < Math.min(png.width, Math.round(box.x2 * sx)); x += 1) {
      const i = (png.width * y + x) << 2
      png.data[i] = 70; png.data[i + 1] = 70; png.data[i + 2] = 70; png.data[i + 3] = 255
    }
  }
}

function secretNodes() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/l580-ui.xml'])
  const xml = adb(['shell', 'cat', '/sdcard/l580-ui.xml']).toString('utf8')
  const out = []
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const tag = match[0]
    const label = ['text', 'content-desc'].map((name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '').join(' ')
    const bounds = tag.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (bounds && secrets.some((secret) => label.includes(secret))) out.push({ x1: +bounds[1], y1: +bounds[2], x2: +bounds[3], y2: +bounds[4] })
  }
  return out
}

const [first, second] = process.argv.slice(2)
if (first === '--repaint') {
  const png = PNG.sync.read(fs.readFileSync(second))
  paint(png, BAND)
  fs.writeFileSync(second, PNG.sync.write(png))
  console.log(JSON.stringify({ at: Date.now(), repaint: second, band: BAND }))
} else if (first) {
  const png = PNG.sync.read(adb(['exec-out', 'screencap', '-p']))
  // 덤프는 화면이 움직이는 중이면 실패한다(「could not get idle state」) — 그때도 띠는 칠하고 실패를 적는다.
  let nodes = []
  let dump = 'ok'
  try {
    nodes = secretNodes()
  } catch {
    dump = 'failed'
  }
  paint(png, BAND)
  for (const node of nodes) paint(png, node)
  fs.writeFileSync(first, PNG.sync.write(png))
  console.log(JSON.stringify({ at: Date.now(), shot: first, band: true, dump, redactedNodes: nodes.length }))
} else {
  console.error('사용: node shot.mjs <파일.png> | --repaint <파일.png>')
  process.exit(2)
}
