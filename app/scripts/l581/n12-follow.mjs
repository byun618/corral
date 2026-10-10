// LIFE-581 네이티브 n-12 재현 — 「맨 아래 따라가기」. 격리 개발 Electron(HOME=<ROOT>/home)의 합성 Claude 대화 하나를 에뮬레이터 개발 앱(실 RN 렌더)에 열어 두고,
// 회차마다 ① 맨 아래인지 확인(uiautomator 덤프 — 마지막 답 글 노드가 목록 아래 끝보다 위에서 끝남 · `새 메시지 ↓` 없음) ② 모드대로 줄을 쓰고 ③ 3초 뒤 덤프·캡처로 판정한다.
//   ⓐ a  지시 1줄 → 1 s 뒤 답 1줄(두 프레임)
//   ⓑ b  지시 1줄 → 1 s 뒤 답 3줄
//   ⓒ c  지시 + 답 한 번에(한 프레임)
//   ⓓ d  같은 message.id 답이 자람(블록 둘, ~1 s 간격) — 지시 먼저
// 판정: 새 답의 마지막 줄(표지 `N12-<모드>-<n>-end`)이 덤프에 있고 그 노드 아래 끝이 목록 아래 끝보다 위(잘리면 덤프 bounds 가 목록 끝에 잘려 같아진다) = 「보임」,
//       없거나 잘림 + `새 메시지 ↓` 있음 = 「버튼」, 없거나 잘림 + 버튼 없음 = 「잘림」(n-12 실패 모양).
// 대화의 글은 전부 합성(G5). 캡처는 대화 화면만(머리에 맥 이름 없음).
//
//   node scripts/l581/n12-follow.mjs build --root /tmp/l581g-n --fake /tmp/l581g-fn --out <scene.json>
//   node scripts/l581/n12-follow.mjs run   --root /tmp/l581g-n --scene <scene.json> --mode a --runs 5 --tag pre --out <dir>
//   --offset <dp>  맨 아래 확인 뒤 천천히 끌어 그만큼 띄운다(회차 `offsetDp` 는 마지막 글 노드 gap 차이라 **하한**이다 — 노드가 목록 끝에 잘리면 gap 0 에서 멈춰 26.3dp 로 찍힌다. 실제 거리는 임시 계측 `onScroll` 로 40 → 40.0dp 확인). 「맨 아래 근처」·「위를 보던 사람」 두 경우.
// 종료 코드: 0 = 모든 회차가 맨 아래에서 시작했고 「보임」 · 1 = 하나라도 아님(재현) · 2 = 사용법·맨 아래 확인 실패.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoots, setMobile, sleep, writeJson } from './lib.mjs'
import { Conversation, agentPane } from './rec.mjs'

const { positionals, values: args } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, scene: { type: 'string' }, mode: { type: 'string' }, runs: { type: 'string' }, tag: { type: 'string' }, gap: { type: 'string' }, offset: { type: 'string' } } })
const cmd = positionals[0]
const ROOT = args.root
if (!/^\/tmp\/l581g-[^/]+$/.test(ROOT ?? '')) {
  console.error('--root /tmp/l581g-* 필요')
  process.exit(2)
}

const adb = (rest) => execFileSync('adb', ['-s', 'emulator-5554', ...rest], { maxBuffer: 32 * 1024 * 1024 })
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n')

/** 화면 노드(글·bounds·scrollable). 덤프 실패(애니메이션 중 등)면 몇 번 다시. 이전 덤프 파일을 지우고 찍는다(낡은 파일을 읽지 않게). */
async function dump() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      adb(['shell', 'rm', '-f', '/sdcard/n12.xml'])
      adb(['shell', 'uiautomator', 'dump', '/sdcard/n12.xml'])
      const xml = adb(['exec-out', 'cat', '/sdcard/n12.xml']).toString('utf8')
      const nodes = [...xml.matchAll(/<node [^>]*?>/g)].map(([tag]) => {
        const attr = (name) => decode(tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '')
        const [x1, y1, x2, y2] = (attr('bounds').match(/\d+/g) ?? ['0', '0', '0', '0']).map(Number)
        return { text: attr('text') || attr('content-desc'), scrollable: attr('scrollable') === 'true', x1, y1, x2, y2 }
      })
      if (nodes.length > 0) return nodes
    } catch {
      // 다시
    }
    await sleep(700)
  }
  throw new Error('uiautomator 덤프 실패')
}

/** 대화 목록(가장 큰 scrollable)의 아래 끝 · 표지가 든 글 노드 · 새 메시지 버튼. */
function judge(nodes, marker) {
  const list = nodes.filter((node) => node.scrollable).sort((a, b) => (b.y2 - b.y1) - (a.y2 - a.y1))[0] ?? null
  // 같은 표지가 여럿이면 화면에서 가장 아래 것(= 가장 새 것). 덤프 순서는 뒤집힌 목록에서 화면 순서와 다르다(N-2* 첫 판이 위쪽 옛 노드를 골라 맨 아래 확인에서 멈췄다).
  const hit = nodes.filter((node) => node.text.includes(marker)).sort((a, b) => b.y2 - a.y2)[0] ?? null
  const button = nodes.some((node) => node.text.includes('새 메시지'))
  const full = list !== null && hit !== null && hit.y2 < list.y2 - 4
  // gap = 목록 아래 끝 − 그 글 노드 아래 끝(px). 맨 아래(offset 0)면 목록 아래 패딩(12dp ≈ 31px)과 말풍선 아래 여백만큼.
  return { listBottom: list?.y2 ?? null, node: hit === null ? null : { y1: hit.y1, y2: hit.y2 }, gap: list !== null && hit !== null ? list.y2 - hit.y2 : null, button, result: full ? '보임' : button ? '버튼' : '잘림' }
}

// 맨 아래(offset 0)일 때 마지막 답 글 노드 아래 끝 ~ 목록 아래 끝 거리(px) — 에뮬레이터 1080×2400·밀도 420 실측(N-01 20회 전부 69).
const BOTTOM_GAP = 69

const loadScene = () => JSON.parse(fs.readFileSync(args.scene, 'utf8'))
function conversation(scene) {
  const conv = new Conversation({ root: ROOT, agent: 'claude', id: scene.id })
  conv.n = scene.n
  conv.last = scene.last
  return conv
}

async function build() {
  checkRoots({ root: ROOT, fake: args.fake })
  await setMobile(ROOT, args.fake, true)
  const id = `l581-n12-${Date.now().toString(36)}`
  const conv = new Conversation({ root: ROOT, agent: 'claude', id })
  for (let i = 1; i <= 12; i += 1) {
    conv.write('prompt', `N12 앞선 지시 ${i}`)
    conv.write('reply', `N12-seed-${i}`, { text: `N12 앞선 답 ${i}\n둘째 줄 N12-seed-${i}-end` })
  }
  const { paneId } = await agentPane({ root: ROOT, name: 'n12-follow', agent: 'claude', id, state: 'idle' })
  const scene = { paneId, id, file: conv.file, n: conv.n, last: conv.last, lastMarker: 'N12-seed-12-end' }
  fs.writeFileSync(args.out, JSON.stringify(scene, null, 2))
  console.log(JSON.stringify({ paneId, id }))
}

/** 모드대로 쓴다. 반환 = 마지막 줄 표지와 쓴 시각들. */
async function write(conv, mode, label, n, gapMs) {
  // 표지는 회차마다 유일 — 모드·오프셋·묶음 이름(label)과 회차 번호. 첫 판은 `N12-<모드>-<n>` 이라 묶음끼리 겹쳐 옛 말풍선을 새 것으로 셌다(N-1a-o100 1회차).
  const tag = `N12-${label}-${n}`
  const end = `${tag}-end`
  const at = []
  switch (mode) {
    case 'a':
      at.push(conv.write('prompt', `${tag} 지시`))
      await sleep(gapMs)
      at.push(conv.write('reply', tag, { text: `${tag} 답 ${end}` }))
      break
    case 'b':
      at.push(conv.write('prompt', `${tag} 지시`))
      await sleep(gapMs)
      at.push(conv.write('reply', tag, { text: `${tag} 첫 줄\n둘째 줄\n셋째 줄 ${end}` }))
      break
    case 'c':
      at.push(conv.append([...conv.lines('prompt', `${tag} 지시`), ...conv.lines('reply', tag, { text: `${tag} 답 ${end}` })]))
      break
    case 'd': {
      at.push(conv.write('prompt', `${tag} 지시`))
      await sleep(gapMs)
      const messageId = `m-${tag}`
      at.push(conv.write('reply', tag, { messageId, text: `${tag} 첫 블록` }))
      await sleep(gapMs)
      at.push(conv.write('reply', tag, { messageId, text: `${tag} 둘째 블록\n자란 줄 ${end}` }))
      break
    }
    default:
      throw new Error(`모드 ${mode}`)
  }
  return { end, at }
}

async function run() {
  const scene = loadScene()
  const mode = args.mode
  const runs = Number(args.runs ?? 5)
  const gapMs = Number(args.gap ?? 1000)
  const out = path.resolve(args.out)
  const label = `${mode}${args.offset === undefined ? '' : `-o${args.offset}`}-${args.tag ?? 'r'}`
  fs.mkdirSync(path.join(out, 'shots'), { recursive: true })
  const rows = []
  for (let i = 1; i <= runs; i += 1) {
    const n = `${args.tag ?? 'r'}${i}`
    // ① 맨 아래 확인 — 직전 마지막 답 글이 다 보이고 버튼이 없어야 한다. 아니면 맨 아래로 내린다(버튼 누르기 또는 아래로 밀기) 뒤 다시 확인.
    let before = judge(await dump(), scene.lastMarker)
    if (before.result !== '보임' || before.gap !== BOTTOM_GAP) {
      adb(['shell', 'input', 'swipe', '540', '1800', '540', '500', '150']) // 손가락을 위로 = 뒤집힌 목록에서 새 쪽(아래)으로
      await sleep(1500)
      before = judge(await dump(), scene.lastMarker)
    }
    if (before.result !== '보임' || before.gap !== BOTTOM_GAP) {
      rows.push({ n, mode, before, error: '맨 아래 확인 실패 — 회차 안 셈' })
      continue
    }
    // --offset <dp>: 맨 아래 확인 뒤 손가락을 천천히 아래로 끌어(뒤집힌 목록 — 과거 쪽) 그만큼 띄운다. 실제로 뜬 양은 덤프 gap 차이로 잰다(터치 슬롭이 조금 먹는다).
    let offsetDp = 0
    if (args.offset !== undefined) {
      const px = Math.round(Number(args.offset) * 2.625)
      adb(['shell', 'input', 'swipe', '540', '1200', '540', String(1200 + px + 21), '1500'])
      await sleep(1500)
      const moved = judge(await dump(), scene.lastMarker)
      // 과거 쪽으로 뜨면 마지막 말풍선이 아래로 내려가 gap 이 준다 — 뜬 양 = (전 gap − 뒤 gap). 첫 판은 부호가 거꾸로였다(N-1a-o40 의 −26.3 = 실제 +26.3).
      offsetDp = moved.gap === null || before.gap === null ? null : Math.round(((before.gap - moved.gap) / 2.625) * 10) / 10
      before = { ...before, moved }
    }
    const conv = conversation(scene)
    const written = await write(conv, mode, label, n, gapMs)
    scene.n = conv.n
    scene.last = conv.last
    scene.lastMarker = written.end
    fs.writeFileSync(args.scene, JSON.stringify(scene, null, 2))
    await sleep(3000)
    const shot = path.join(out, 'shots', `${label}-${n}.png`)
    fs.writeFileSync(shot, adb(['exec-out', 'screencap', '-p']))
    const after = judge(await dump(), written.end)
    rows.push({ n, mode, offsetDp, before, writtenAt: written.at, after, shot: path.relative(out, shot) })
    console.log(JSON.stringify({ n, mode, offsetDp, before: before.result, beforeGap: before.gap, after: after.result, afterGap: after.gap, node: after.node, listBottom: after.listBottom, button: after.button }))
    // 다음 회차 전 — 잘렸으면 맨 아래로 돌려 둔다(다음 회차의 ① 이 다시 확인한다)
    await sleep(800)
  }
  const counted = rows.filter((row) => row.error === undefined)
  const result = { measuredAt: new Date().toISOString(), mode, gapMs, runs, counted: counted.length, tally: counted.reduce((acc, row) => ({ ...acc, [row.after.result]: (acc[row.after.result] ?? 0) + 1 }), {}), rows }
  writeJson(path.join(out, `n12-${label}.json`), { ...result, offset: args.offset ?? null })
  console.log(JSON.stringify({ mode, counted: result.counted, tally: result.tally }))
  if (counted.length < runs) process.exit(2)
  process.exit(counted.every((row) => row.after.result === '보임') ? 0 : 1)
}

const fn = { build, run }[cmd]
if (fn === undefined) {
  console.error('명령: build · run')
  process.exit(2)
}
fn().catch((error) => {
  console.error(error)
  process.exit(2)
})
