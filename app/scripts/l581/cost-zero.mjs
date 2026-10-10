// LIFE-581 Y10ⓑ 격리 — 모바일 꺼짐·열린 대화 0 이면 대화 판독 비용 0. 격리 개발 Electron(HOME=<ROOT>/home)의 합성 Claude 기록에 줄을 쓰며 main 로그를 센다.
//   ① 모바일 꺼짐 10초(1줄/초)  ② 모바일 켜짐 + 폰 자리 1(목록만 구독, 대화 구독 0) 10초  ③ 양성 대조 — 같은 폰 자리가 그 대화를 구독하고 5초
// 대화 판독의 흔적 = main 로그 `mobile.chat_index`·`chat_page`·`chat_push`·`chat_subscribe`·`chat_index_paused`(판독자가 있을 때만 나는 줄).
// 통과: ①·② 에서 0 · ③ 에서 index ≥ 1 · push ≥ 1(대조가 실제로 그 줄을 잡는다). 참고로 데스크톱 지문 판독(`transcript.read`)은 세 구간 모두 센다(이 작업과 무관한 기존 비용).
//
//   node scripts/l581/cost-zero.mjs --root /tmp/l581g-g --fake /tmp/l581g-fg --out <dir>
// 종료 코드: 0 통과 · 1 미달 · 2 사용법.
import path from 'node:path'
import { parseArgs } from 'node:util'
import fs from 'node:fs'
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
const LOG = path.join(ROOT, 'ud/corral.ndjson')
const CHAT_TAGS = ['mobile.chat_index', 'mobile.chat_page', 'mobile.chat_push', 'mobile.chat_subscribe', 'mobile.chat_index_paused']
const lineCount = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').length : 0)
const tally = (from) => {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').slice(from - 1).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row !== null)
  const out = Object.fromEntries([...CHAT_TAGS, 'transcript.read'].map((tag) => [tag, rows.filter((row) => row.tag === tag).length]))
  return { ...out, chatTotal: CHAT_TAGS.reduce((sum, tag) => sum + out[tag], 0) }
}

async function phase(conv, seconds, label, from = lineCount()) {
  for (let i = 0; i < seconds; i += 1) {
    conv.write(i % 2 === 0 ? 'reply' : 'tool', `L581-K9B-${label}-${i}`, { callId: `k9b-${label}-${i}` })
    await sleep(1_000)
  }
  await sleep(500)
  return tally(from)
}

async function main() {
  await setMobile(ROOT, args.fake, false)
  const id = `l581-k9b-${Date.now().toString(36)}`
  const conv = new Conversation({ root: ROOT, agent: 'claude', id })
  conv.write('prompt', 'L581-K9B-seed')
  const { paneId } = await agentPane({ root: ROOT, name: `k9b-${Date.now().toString(36)}`, agent: 'claude', id, state: 'idle' })
  await sleep(1_500)
  const off = await phase(conv, 10, 'off')
  await setMobile(ROOT, args.fake, true)
  const token = await pairDevice(ROOT, { name: 'l581-k9b' })
  const frames = []
  const client = await phone(ROOT, { token, name: 'l581-k9b', onFrame: ({ message }) => frames.push(message.type) })
  await until(() => channelOf(client.lastList()?.list, paneId), { timeoutMs: 15_000, label: '채널' })
  const listOnly = await phase(conv, 10, 'list')
  // 대조 구간은 구독 **앞**부터 센다 — 색인·구독 줄은 구독 순간에 난다(F-G1 첫 회차는 구독 뒤부터 세어 index 0 이었다 — 도구 결함).
  const controlFrom = lineCount()
  client.chat(paneId)
  await until(() => frames.includes('chat.page'), { timeoutMs: 10_000, label: '대조 첫 페이지' })
  const control = await phase(conv, 5, 'chat', controlFrom)
  await client.close()
  await revokeAll(ROOT)
  await setMobile(ROOT, args.fake, false)
  const pass = off.chatTotal === 0 && listOnly.chatTotal === 0 && control['mobile.chat_index'] >= 1 && control['mobile.chat_push'] >= 1
  const result = { measuredAt: new Date().toISOString(), phases: { mobileOff: off, listOnly, positiveControl: control }, framesByType: frames.reduce((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {}), pass }
  writeJson(path.join(path.resolve(args.out), 'cost-zero.json'), result)
  console.log(JSON.stringify(result))
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
