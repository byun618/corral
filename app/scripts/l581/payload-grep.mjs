// LIFE-581 Y9ⓓ 격리 — 실제 페이로드 grep. 격리 앱의 합성 기록에 **심은 표지**(생각 본문 · 도구 결과 본문 · 가짜 HOME 아래 절대경로 — 날것·퍼센트 인코딩 1·2중)를 넣고
// 폰 자리가 받은 프레임 원문 전체(목록 · 대화 첫 페이지 · push · 과거 페이지)에서 다음을 센다 — 전부 0 이어야 한다:
//   생각 표지 · 결과 표지 · 세션 참조 원문(세션 id · 기록 파일 경로 · 기록 파일 이름) · 기기 토큰 · HOME(가짜·실제) 아래 절대경로(날것·인코딩 1·2중).
// 양성 대조 ①: 같은 grep 을 **기록 파일**에 돌리면 심은 종류마다 ≥ 1 — 표지가 실제로 기록에 있었다.
// 양성 대조 ②: 받은 원문 + 심은 문자열(종류마다 하나씩 덧붙인 사본)에 돌리면 종류마다 ≥ 1 — grep 이 그 모양을 실제로 잡는다.
// 양성 대조 ③: 가린 결과(`~/l581-secret`)가 받은 원문에 있다 — 경로를 실제로 보냈고 가렸다(지워서 0 이 된 것이 아니다).
// 받은 원문은 `<ROOT>/payload.txt`(커밋 안 함 — 합성 글뿐이지만 토큰이 섞일 수 있어 /tmp 에만). 원자료에는 패턴 이름·개수만.
//
//   node scripts/l581/payload-grep.mjs --root /tmp/l581g-d --fake /tmp/l581g-fd --out <dir>
// 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { channelOf, checkRoots, pairDevice, phone, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'
import { Conversation, agentPane } from './rec.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
const FAKE_HOME = path.join(ROOT, 'home')
// 격리 앱의 HOME 은 realpath 로 잡힌다(`index.ts` homeDirReal — /tmp → /private/tmp). 실기 HOME(/Users/…)에는 심볼릭 링크가 없어 두 모양이 같다.
// 심는 경로는 앱이 아는 모양(realpath)으로, grep 은 두 모양 다(F-Y9d 첫 회차가 /tmp 모양을 심어 가림 대상 밖이었다 — 도구 결함).
const FAKE_HOME_REAL = (() => { fs.mkdirSync(FAKE_HOME, { recursive: true }); return fs.realpathSync(FAKE_HOME) })()
const REAL_HOME = os.userInfo().homedir
const enc1 = (text) => encodeURIComponent(text)
const enc2 = (text) => encodeURIComponent(encodeURIComponent(text))

async function main() {
  await setMobile(ROOT, args.fake, true)
  const tag = Date.now().toString(36)
  const secretPath = `${FAKE_HOME_REAL}/l581-secret/plan.txt`
  const token = await pairDevice(ROOT, { name: 'l581-y9d' })
  const raws = []
  const client = await phone(ROOT, { token, name: 'l581-y9d', onFrame: ({ raw }) => raws.push(raw) })
  const convs = []
  for (const agent of ['claude', 'codex', 'grok']) {
    const id = `l581-y9d-${agent}-${tag}`
    const conv = new Conversation({ root: ROOT, agent, id })
    conv.write('prompt', `L581-Y9D-${agent} 경로 ${secretPath} 인코딩 ${enc1(secretPath)} 두 번 ${enc2(secretPath)}`)
    conv.write('thinking', `L581-Y9D-${agent}-think`)
    conv.write('tool', `L581-Y9D-${agent}-tool cat ${secretPath}`, { callId: 'y9d1' })
    conv.write('tool_result', 'x', { callId: 'y9d1' })
    conv.write('reply', `L581-Y9D-${agent}-reply ${secretPath}`)
    const { paneId } = await agentPane({ root: ROOT, name: `y9d-${agent}-${tag}`, agent, id, state: 'idle' })
    convs.push({ agent, id, conv, paneId })
  }
  for (const entry of convs) {
    await until(() => channelOf(client.lastList()?.list, entry.paneId), { timeoutMs: 15_000, label: `${entry.agent} 채널` })
    const before = raws.length
    client.chat(entry.paneId)
    await until(() => raws.slice(before).some((raw) => raw.includes('"chat.page"')), { timeoutMs: 10_000, label: `${entry.agent} 첫 페이지` })
    // push 도 원문에 넣는다 — 생각·결과·경로가 든 줄을 구독 뒤에 한 번 더.
    entry.conv.write('thinking', `L581-Y9D-${entry.agent}-think-live`)
    entry.conv.write('tool', `L581-Y9D-${entry.agent}-tool-live ${secretPath}`, { callId: 'y9d2' })
    entry.conv.write('tool_result', 'x', { callId: 'y9d2', error: true })
    entry.conv.write('reply', `L581-Y9D-${entry.agent}-reply-live ${enc1(secretPath)}`)
    await until(() => raws.slice(before).some((raw) => raw.includes(`L581-Y9D-${entry.agent}-reply-live`)), { timeoutMs: 10_000, label: `${entry.agent} push` })
    await sleep(500)
  }
  await client.close()
  await revokeAll(ROOT)
  const payload = raws.join('\n')
  fs.writeFileSync(path.join(ROOT, 'payload.txt'), payload, { mode: 0o600 })
  const patterns = {
    thought: ['SECRET_THOUGHT_MARKER'],
    result: ['SYNTHETIC_RESULT_BODY'],
    sessionRef: convs.flatMap((entry) => [entry.id, entry.conv.file, path.basename(entry.conv.file)]),
    token: [token],
    fakeHomeRaw: [FAKE_HOME_REAL, FAKE_HOME],
    fakeHomeEnc1: [enc1(FAKE_HOME_REAL), enc1(FAKE_HOME)],
    fakeHomeEnc2: [enc2(FAKE_HOME_REAL), enc2(FAKE_HOME)],
    realHomeRaw: [REAL_HOME],
    realHomeEnc1: [enc1(REAL_HOME)],
    realHomeEnc2: [enc2(REAL_HOME)],
  }
  const count = (text, list) => list.reduce((sum, needle) => sum + (needle.length === 0 ? 0 : text.split(needle).length - 1), 0)
  const inPayload = Object.fromEntries(Object.entries(patterns).map(([name, list]) => [name, count(payload, list)]))
  const records = convs.map((entry) => fs.readFileSync(entry.conv.file, 'utf8')).join('\n')
  // 기록에는 심은 종류(생각·결과·가짜 HOME 날것·인코딩)가 있어야 한다 — 세션 id 는 Claude·Grok 기록 안에, 토큰·실제 HOME 은 기록에 없다(대조 대상 아님).
  const plantedKinds = ['thought', 'result', 'fakeHomeRaw', 'fakeHomeEnc1', 'fakeHomeEnc2']
  const inRecords = Object.fromEntries(plantedKinds.map((name) => [name, count(records, patterns[name])]))
  const spiked = payload + '\n' + Object.values(patterns).map((list) => list[0]).join('\n')
  const inSpiked = Object.fromEntries(Object.entries(patterns).map(([name, list]) => [name, count(spiked, [list[0]])]))
  const maskedShown = count(payload, ['~/l581-secret/plan.txt'])
  const summary = { frames: raws.length, bytes: Buffer.byteLength(payload), chatFrames: raws.filter((raw) => raw.includes('"chat.')).length, inPayload, positive: { inRecords, inSpiked, maskedShown } }
  const pass = Object.values(inPayload).every((value) => value === 0) && Object.values(inRecords).every((value) => value > 0) && Object.values(inSpiked).every((value) => value > 0) && maskedShown > 0
  writeJson(path.join(OUT, 'payload-grep.json'), { measuredAt: new Date().toISOString(), payloadFile: '<ROOT>/payload.txt (커밋 안 함)', patterns: Object.fromEntries(Object.entries(patterns).map(([name, list]) => [name, list.length])), summary, pass })
  console.log(JSON.stringify({ summary, pass }))
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
