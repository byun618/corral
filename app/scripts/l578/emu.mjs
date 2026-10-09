// LIFE-578 최종 관문 격리 회차 — 에뮬레이터 UI 조작 도구. 대상은 늘 `-s emulator-5554`(폰에 명령을 보내지 않는다 — 02-kickoff 격리 5).
// 사용: node emu.mjs texts                    — 화면의 글자(text·content-desc) 목록
//       node emu.mjs tap "<글자>"             — 그 글자를 담은 노드의 가운데를 누른다(첫 일치)
//       node emu.mjs wait "<글자>" [ms]       — 그 글자가 보일 때까지(시각 ms 를 찍는다), 넘으면 exit 1
//       node emu.mjs gone "<글자>" [ms]       — 그 글자가 사라질 때까지
//       node emu.mjs shot <파일.png>          — 화면 캡처
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const SERIAL = 'emulator-5554'
const adb = (args, opts = {}) => execFileSync('adb', ['-s', SERIAL, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts })

export function nodes() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/l578-ui.xml'], { stdio: ['ignore', 'ignore', 'ignore'] })
  const xml = adb(['shell', 'cat', '/sdcard/l578-ui.xml']).toString('utf8')
  const out = []
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const tag = match[0]
    const attr = (name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ''
    const bounds = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    const label = [attr('text'), attr('content-desc')].filter(Boolean).join(' | ')
    if (label && bounds) {
      const [x1, y1, x2, y2] = [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])]
      out.push({ label: decode(label), x: (x1 + x2) >> 1, y: (y1 + y2) >> 1, x1, y1, x2, y2 })
    }
  }
  return out
}

function decode(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n')
}

/** 글자가 똑같은 노드를 먼저, 없으면 포함하는 노드(마지막 — 버튼이 본문 아래에 있는 화면이 많다). */
/** G5 — 원자료에 남기면 안 되는 값(맥 컴퓨터 이름 등). 파일 L578_REDACT_FILE 의 줄마다 하나. */
const SECRETS = (() => {
  try {
    return fs.readFileSync(process.env.L578_REDACT_FILE ?? '/tmp/l578fg/sec/macname', 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
})()
const scrub = (text) => SECRETS.reduce((acc, secret) => acc.split(secret).join('<mac>'), text)

const find = (text) => {
  const all = nodes()
  return all.find((node) => node.label.split(' | ').includes(text)) ?? all.filter((node) => node.label.includes(text)).at(-1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const [cmd, arg, extra] = process.argv.slice(2)
if (cmd === 'texts') {
  for (const node of nodes()) console.log(scrub(node.label.replace(/\n/g, ' ⏎ ')))
} else if (cmd === 'tap') {
  const node = find(arg)
  if (node === undefined) {
    console.log(JSON.stringify({ tap: arg, found: false }))
    process.exit(1)
  }
  adb(['shell', 'input', 'tap', String(node.x), String(node.y)])
  console.log(JSON.stringify({ at: Date.now(), tap: arg, x: node.x, y: node.y }))
} else if (cmd === 'wait' || cmd === 'gone') {
  const t0 = Date.now()
  const limit = Number(extra ?? 20_000)
  for (;;) {
    const seen = find(arg) !== undefined
    if (seen === (cmd === 'wait')) {
      console.log(JSON.stringify({ at: Date.now(), [cmd]: arg, ms: Date.now() - t0 }))
      break
    }
    if (Date.now() - t0 > limit) {
      console.log(scrub(JSON.stringify({ at: Date.now(), [cmd]: arg, timeoutMs: limit, screen: nodes().map((node) => node.label) })))
      process.exit(1)
    }
    await sleep(250)
  }
} else if (cmd === 'clip') {
  // 에뮬레이터 클립보드에 파일 내용을 넣는다 — 맥 클립보드는 건드리지 않는다. 연락처 편집기의 입력칸에 쳐서 Ctrl+A·Ctrl+C 한 뒤 버리고 나온다.
  // 내용(페어링 페이로드 = 코드 포함)은 출력에 찍지 않는다.
  const text = fs.readFileSync(arg, 'utf8').trim()
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.INSERT', '-t', 'vnd.android.cursor.dir/contact'], { stdio: 'ignore' })
  let field
  for (let i = 0; i < 20 && field === undefined; i += 1) {
    await sleep(500)
    field = nodes().find((node) => node.label === 'First name')
  }
  if (field === undefined) {
    console.log(JSON.stringify({ at: Date.now(), clip: arg, error: 'First name 칸 없음' }))
    process.exit(1)
  }
  adb(['shell', 'input', 'tap', String(field.x), String(field.y)])
  await sleep(800)
  const quoted = `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`
  adb(['shell', `input text ${quoted}`])
  await sleep(500)
  adb(['shell', 'input', 'keycombination', '113', '29']) // Ctrl+A
  await sleep(300)
  adb(['shell', 'input', 'keycombination', '113', '31']) // Ctrl+C
  await sleep(500)
  adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  // 편집기를 저장하지 않고 닫는다 — 「Discard」 확인이 뜰 때까지(최대 5초) 기다렸다 누른다
  let discard
  for (let i = 0; i < 10 && discard === undefined; i += 1) {
    await sleep(500)
    discard = nodes().find((node) => node.label === 'Discard')
  }
  if (discard) adb(['shell', 'input', 'tap', String(discard.x), String(discard.y)])
  await sleep(800)
  adb(['shell', 'am', 'force-stop', 'com.google.android.contacts']) // 편집기를 남기지 않는다(저장 안 함)
  console.log(JSON.stringify({ at: Date.now(), clip: arg, chars: text.length, field: field?.label ?? null, discard: discard?.label ?? null }))
} else if (cmd === 'shot') {
  // 캡처 + 가림: 비밀 값을 담은 노드의 사각형을 칠한다(G5). 가린 노드 수를 찍는다.
  const raw = adb(['exec-out', 'screencap', '-p']) // 먼저 찍는다(노드 덤프는 ~1–2초 걸린다) — 가릴 자리는 그 뒤 덤프로
  const covered = nodes().filter((node) => SECRETS.some((secret) => node.label.includes(secret)))
  const { PNG } = createRequire(import.meta.url)('pngjs')
  const png = PNG.sync.read(raw)
  for (const node of covered) {
    for (let y = Math.max(0, node.y1); y < Math.min(png.height, node.y2); y += 1) {
      for (let x = Math.max(0, node.x1); x < Math.min(png.width, node.x2); x += 1) {
        const i = (png.width * y + x) << 2
        png.data[i] = 70; png.data[i + 1] = 70; png.data[i + 2] = 70; png.data[i + 3] = 255
      }
    }
  }
  fs.writeFileSync(arg, PNG.sync.write(png))
  console.log(JSON.stringify({ at: Date.now(), shot: arg, redactedNodes: covered.length }))
} else {
  console.log('명령: texts · tap · wait · gone · shot')
  process.exit(2)
}
