// LIFE-581 R5-A1 — 에뮬레이터(`emulator-5554`) 실 RN 제스처 재현. `r5a1-setup.py` 사본 + Metro(로그 `/tmp/l581g-r5/metro.log`) 위 fixture 를 친다.
// 회차마다 RESET(다시 마운트 = offset 0) → 모드대로 제스처·답 → 3 s·10 s 뒤 덤프·캡처. 결정 offset 은 Metro 로그의 계측(`R5_SCROLL`)에서 읽는다 —
// 따라가기(`R5_FOLLOW`) 직전, 없으면 마지막 `R5_SCROLL`. 기대: 결정 offset ≤ 120 dp 면 새 답 끝 표지 「보임」, 넘으면 「버튼」(`새 메시지 ↓`).
//   during  DELAY(1.8 s 뒤 답) + 천천히 끌기 `--drag` px / 4.5 s — R5-A1 경로(끄는 중 도착 → 임계 안에서 놓음)
//   away    DELAY + 441 px / 2 s 끌기 — 끄는 중 도착 → 임계 밖에서 놓음
//   fling   SOON(0.3 s 뒤 답) + 짧은 fling `--dist` px / `--dur` ms — 관성 중·직후 도착
//   still   `--offset` dp 까지 천천히 끌고 0.8 s 쉰 뒤 PUSH — n-12 정지 회귀(0·40·100·160)
//   fold    FOLD(30줄 답 — 24줄 접힘) → GROW(같은 id 에 숨은 줄 +4) → 맨 아래 유지 관측 → 60 dp 끌고 놓기 관측(P02)
//   node scripts/l581/r5a1-gesture.mjs --mode during --runs 5 --tag fix --out <dir> [--drag 178] [--dist 90 --dur 60] [--offset 40]
// 종료 코드: 0 전부 기대대로 · 1 하나라도 아님 · 2 사용법·덤프 실패.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({ options: { mode: { type: 'string' }, runs: { type: 'string' }, tag: { type: 'string' }, out: { type: 'string' }, drag: { type: 'string' }, dist: { type: 'string' }, dur: { type: 'string' }, offset: { type: 'string' } } })
const MODES = ['during', 'away', 'fling', 'still', 'fold']
if (!MODES.includes(args.mode ?? '') || args.out === undefined || args.tag === undefined) {
  console.error(`--mode ${MODES.join('|')} --tag <이름> --out <dir> 필요`)
  process.exit(2)
}
const METRO_LOG = '/tmp/l581g-r5/metro.log'
const DP = 2.625
const NEAR_BOTTOM = 120
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const adb = (rest) => execFileSync('adb', ['-s', 'emulator-5554', ...rest], { maxBuffer: 32 * 1024 * 1024 })
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n')
const metroLines = () => fs.readFileSync(METRO_LOG, 'utf8').split('\n')

async function dump() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      adb(['shell', 'rm', '-f', '/sdcard/l581r5a1.xml'])
      adb(['shell', 'uiautomator', 'dump', '/sdcard/l581r5a1.xml'])
      const xml = adb(['exec-out', 'cat', '/sdcard/l581r5a1.xml']).toString('utf8')
      const nodes = [...xml.matchAll(/<node [^>]*?>/g)].map(([tag]) => {
        const attr = (name) => decode(tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '')
        const [x1, y1, x2, y2] = (attr('bounds').match(/-?\d+/g) ?? ['0', '0', '0', '0']).map(Number)
        return { text: attr('text'), scrollable: attr('scrollable') === 'true', x1, y1, x2, y2 }
      })
      if (nodes.length > 0) return nodes
    } catch {
      // 다시
    }
    await sleep(700)
  }
  throw new Error('uiautomator 덤프 실패')
}

async function tap(label) {
  const node = (await dump()).find((candidate) => candidate.text === label)
  if (node === undefined) throw new Error(`버튼 ${label} 없음`)
  adb(['shell', 'input', 'tap', String((node.x1 + node.x2) >> 1), String((node.y1 + node.y2) >> 1)])
}

/** 목록(가장 큰 scrollable) 아래 끝 · 가장 새 답 끝 표지 노드 · 접힘 「더 보기」 노드 · 버튼. */
function judge(nodes) {
  const list = nodes.filter((node) => node.scrollable).sort((a, b) => b.y2 - b.y1 - (a.y2 - a.y1))[0] ?? null
  const ids = nodes.flatMap((node) => [...node.text.matchAll(/R5-NEW-(\d+)-END/g)].map((match) => ({ id: Number(match[1]), node })))
  const newest = ids.sort((a, b) => b.id - a.id)[0] ?? null
  const more = nodes.find((node) => node.text.includes('줄 더 보기')) ?? null
  const button = nodes.some((node) => node.text.includes('새 메시지'))
  const visible = list !== null && newest !== null && newest.node.y2 < list.y2 - 4
  return { listBottom: list?.y2 ?? null, newest: newest === null ? null : { id: newest.id, y1: newest.node.y1, y2: newest.node.y2 }, more: more === null ? null : { text: more.text, y2: more.y2 }, button, result: visible ? '보임' : button ? '버튼' : '잘림' }
}

async function capture(dir, name) {
  const judged = judge(await dump())
  const file = path.join(dir, 'shots', `${name}.png`)
  fs.writeFileSync(file, adb(['exec-out', 'screencap', '-p']))
  execFileSync('sips', ['-Z', '1200', file], { stdio: 'ignore' })
  return { ...judged, shot: path.relative(dir, file) }
}

/** 이 회차의 계측 로그 → 단계 순서 · 결정 offset. */
function read(lines) {
  const events = lines.flatMap((line) => {
    const match = line.match(/LOG\s+(R5_[A-Z_]+)(.*)$/)
    return match === null ? [] : [{ name: match[1], rest: match[2].trim() }]
  })
  const firstFollow = events.findIndex((event) => event.name === 'R5_FOLLOW')
  const scrolls = (firstFollow === -1 ? events : events.slice(0, firstFollow)).filter((event) => event.name === 'R5_SCROLL')
  const decideY = scrolls.length === 0 ? 0 : Number(scrolls.at(-1).rest.split(/\s+/)[0])
  const pushAt = events.findIndex((event) => event.name === 'R5_PUSH')
  const before = events.slice(0, pushAt === -1 ? 0 : pushAt).map((event) => event.name)
  const phase = pushAt === -1 ? null : before.lastIndexOf('R5_DRAG_BEGIN') > before.lastIndexOf('R5_DRAG_END') ? 'drag' : before.lastIndexOf('R5_MOMENTUM_BEGIN') > before.lastIndexOf('R5_MOMENTUM_END') ? 'momentum' : before.includes('R5_DRAG_END') ? 'after-release' : 'still'
  return { decideDp: Math.round(decideY * 10) / 10, arrival: phase, follow: events.filter((event) => event.name === 'R5_FOLLOW').map((event) => event.rest), trace: events.filter((event) => event.name !== 'R5_SCROLL').map((event) => `${event.name} ${event.rest}`.trim()) }
}

async function gesture(mode) {
  switch (mode) {
    case 'during':
      await tap('DELAY')
      adb(['shell', 'input', 'swipe', '540', '1200', '540', String(1200 + Number(args.drag ?? 178)), '4500'])
      return
    case 'away':
      await tap('DELAY')
      adb(['shell', 'input', 'swipe', '540', '1200', '540', '1641', '2000'])
      return
    case 'fling':
      await tap('SOON')
      adb(['shell', 'input', 'swipe', '540', '1200', '540', String(1200 + Number(args.dist ?? 90)), String(Number(args.dur ?? 60))])
      return
    case 'still': {
      const px = Math.round(Number(args.offset ?? 0) * DP)
      if (px > 0) adb(['shell', 'input', 'swipe', '540', '1200', '540', String(1200 + px + 21), '1500'])
      await sleep(800)
      await tap('PUSH')
      return
    }
    default:
      throw new Error(mode)
  }
}

async function run() {
  const out = path.resolve(args.out)
  fs.mkdirSync(path.join(out, 'shots'), { recursive: true })
  const runs = Number(args.runs ?? 5)
  const label = `${args.mode}${args.offset === undefined ? '' : `-o${args.offset}`}${args.drag === undefined ? '' : `-d${args.drag}`}${args.dist === undefined ? '' : `-f${args.dist}x${args.dur ?? 60}`}-${args.tag}`
  const rows = []
  for (let i = 1; i <= runs; i += 1) {
    const n = `${label}-${i}`
    try {
      await tap('RESET')
      await sleep(1500)
      const start = metroLines().length
      if (args.mode === 'fold') {
        await tap('FOLD')
        await sleep(2500)
        const folded = await capture(out, `${n}-folded`)
        await tap('GROW')
        await sleep(3000)
        const grown = await capture(out, `${n}-grown`)
        adb(['shell', 'input', 'swipe', '540', '1200', '540', String(1200 + Math.round(60 * DP) + 21), '1500'])
        await sleep(3000)
        const released = await capture(out, `${n}-released`)
        const log = read(metroLines().slice(start))
        // 맨 아래 유지 = GROW 뒤 「더 보기」 노드 아래 끝이 GROW 전과 같다(숨은 줄만 늘어 높이 무변화). 놓은 뒤는 관측만.
        const kept = folded.more !== null && grown.more !== null && folded.more.y2 === grown.more.y2
        rows.push({ n, mode: 'fold', folded, grown, released, kept, log, pass: kept })
        console.log(JSON.stringify({ n, kept, foldedMore: folded.more, grownMore: grown.more, releasedMore: released.more, follow: log.follow, trace: log.trace }))
        continue
      }
      await gesture(args.mode)
      await sleep(3000)
      const after3 = await capture(out, `${n}-after3`)
      await sleep(7000)
      const after10 = await capture(out, `${n}-after10`)
      const log = read(metroLines().slice(start))
      const expect = log.decideDp <= NEAR_BOTTOM ? '보임' : '버튼'
      const pass = after3.result === expect && after10.result === expect
      rows.push({ n, mode: args.mode, expect, after3, after10, log, pass })
      console.log(JSON.stringify({ n, decideDp: log.decideDp, arrival: log.arrival, expect, after3: after3.result, after10: after10.result, pass, follow: log.follow }))
    } catch (error) {
      rows.push({ n, mode: args.mode, error: String(error) })
      console.log(JSON.stringify({ n, error: String(error) }))
    }
  }
  const counted = rows.filter((row) => row.error === undefined)
  const result = { measuredAt: new Date().toISOString(), mode: args.mode, args, runs, counted: counted.length, pass: counted.filter((row) => row.pass).length, rows }
  fs.writeFileSync(path.join(out, `r5a1-${label}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label, counted: result.counted, pass: result.pass }))
  if (counted.length < runs) process.exit(2)
  process.exit(result.pass === runs ? 0 : 1)
}

await run()
