// LIFE-581 Y2ⓐⓑ · Y9ⓒ 격리 — 실서버(격리 개발 Electron, HOME=<ROOT>/home)에서
//   Y2ⓐ AI 채널 구독 → `chat.page`(reset) → 새 줄 → `chat.items`
//   Y2ⓑ 목록에 없는 채널 id · 셸 pane(에이전트 아님) → `chat.unavailable`(`not_listed`, retrying false) — 양성 대조는 ⓐ
//   Y9ⓒ 해지된 기기(4003)·`replaced` 된 이전 연결(4006)엔 그 뒤 대화 0건 — 양성 대조: 그 뒤 살아 있는 연결(다른 기기·새 연결)은 받는다
//
//   node scripts/l581/gate-isolated.mjs --root /tmp/l581g-h --fake /tmp/l581g-fh --out <dir>
// 종료 코드: 0 통과 · 1 미달 · 2 사용법. 원자료: <out>/gate-isolated.json(프레임 종류·사유·닫힘 코드·개수, 글 없음).
import path from 'node:path'
import { parseArgs } from 'node:util'
import { channelOf, checkRoots, ctl, freshPane, pairDevice, phone, revokeAll, setMobile, sleep, status, until, writeJson } from './lib.mjs'
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

const chatTypes = (frames) => frames.filter((frame) => frame.message.type.startsWith('chat.')).map((frame) => ({ type: frame.message.type, mode: frame.message.mode ?? null, reason: frame.message.reason ?? null, retrying: frame.message.retrying ?? null, items: (frame.message.items ?? []).length }))

async function main() {
  await setMobile(ROOT, args.fake, true)
  const tag = Date.now().toString(36)
  const id = `l581-gate-${tag}`
  const conv = new Conversation({ root: ROOT, agent: 'claude', id })
  conv.write('prompt', 'L581-GATE-seed')
  const { paneId } = await agentPane({ root: ROOT, name: `gate-${tag}`, agent: 'claude', id, state: 'idle' })
  const { paneId: shellPane } = await freshPane(ROOT, { name: `gate-shell-${tag}` })
  const result = {}

  // --- Y2ⓐ·ⓑ ---
  const tokenA = await pairDevice(ROOT, { name: 'l581-gate-a' })
  let closedA1 = null
  const a = await phone(ROOT, { token: tokenA, name: 'l581-gate-a', onClose: (event) => { closedA1 = event } })
  await until(() => channelOf(a.lastList()?.list, paneId), { timeoutMs: 15_000, label: '채널' })
  await sleep(1_500)
  const listedShell = channelOf(a.lastList()?.list, shellPane) !== null
  const probe = async (channel) => {
    const from = a.frames.length
    a.chat(channel)
    await until(() => a.frames.slice(from).some((frame) => frame.message.type === 'chat.page' || frame.message.type === 'chat.unavailable'), { timeoutMs: 10_000, label: `구독 ${channel}` })
    await sleep(300)
    return chatTypes(a.frames.slice(from))
  }
  result.y2b = { unknownChannel: await probe('w999:p999'), shellPane: await probe(shellPane), shellListed: listedShell }
  const fromA = a.frames.length
  a.chat(paneId)
  await until(() => a.frames.slice(fromA).some((frame) => frame.message.type === 'chat.page'), { timeoutMs: 10_000, label: 'AI 채널 첫 페이지' })
  conv.write('reply', 'L581-GATE-push')
  await until(() => a.frames.slice(fromA).some((frame) => frame.raw.includes('L581-GATE-push')), { timeoutMs: 10_000, label: 'push' })
  result.y2a = chatTypes(a.frames.slice(fromA))

  // --- Y9ⓒ 해지 ---
  const tokenB = await pairDevice(ROOT, { name: 'l581-gate-b' })
  let closedB = null
  const b = await phone(ROOT, { token: tokenB, name: 'l581-gate-b', onClose: (event) => { closedB = event } })
  await until(() => channelOf(b.lastList()?.list, paneId), { timeoutMs: 15_000, label: 'B 채널' })
  b.chat(paneId)
  await until(() => b.frames.some((frame) => frame.message.type === 'chat.page'), { timeoutMs: 10_000, label: 'B 첫 페이지' })
  const devices = (await status(ROOT)).devices ?? []
  const deviceB = devices.find((device) => device.name === 'l581-gate-b')
  await ctl(ROOT, { cmd: 'mobile-revoke', id: deviceB.id })
  await until(() => closedB !== null, { timeoutMs: 10_000, label: 'B 닫힘' })
  const bCount = b.frames.length
  const aBefore = a.frames.length
  conv.write('reply', 'L581-GATE-after-revoke')
  await until(() => a.frames.slice(aBefore).some((frame) => frame.raw.includes('L581-GATE-after-revoke')), { timeoutMs: 10_000, label: '살아 있는 A 수신' })
  await sleep(800)
  result.y9cRevoke = { closeCode: closedB.code, framesAfter: b.frames.length - bCount, liveReceived: a.frames.slice(aBefore).filter((frame) => frame.raw.includes('L581-GATE-after-revoke')).length }

  // --- Y9ⓒ replaced — 같은 기기(A 토큰)로 새 연결 → 이전 연결 A 는 4006 ---
  let closedA = null
  const aOld = a
  const aOldCount = () => aOld.frames.length
  const a2 = await phone(ROOT, { token: tokenA, name: 'l581-gate-a2', onClose: (event) => { closedA = event } })
  await until(() => channelOf(a2.lastList()?.list, paneId), { timeoutMs: 15_000, label: 'A2 채널' })
  a2.chat(paneId)
  await until(() => a2.frames.some((frame) => frame.message.type === 'chat.page'), { timeoutMs: 10_000, label: 'A2 첫 페이지' })
  await sleep(500)
  const oldFrom = aOldCount()
  const a2From = a2.frames.length
  conv.write('reply', 'L581-GATE-after-replace')
  await until(() => a2.frames.slice(a2From).some((frame) => frame.raw.includes('L581-GATE-after-replace')), { timeoutMs: 10_000, label: 'A2 수신' })
  await sleep(800)
  const oldReplaced = aOld.frames.some((frame) => frame.message.type === 'error' || frame.message.code === 'replaced')
  result.y9cReplaced = { oldCloseCode: closedA1?.code ?? null, oldFramesAfter: aOld.frames.slice(oldFrom).length, oldSawReplacedFrame: oldReplaced, newReceived: a2.frames.slice(a2From).filter((frame) => frame.raw.includes('L581-GATE-after-replace')).length, a2Closed: closedA }
  await a2.close()
  await aOld.close()
  await revokeAll(ROOT)

  const problems = []
  const unavailable = (rows) => rows.length >= 1 && rows.every((row) => row.type === 'chat.unavailable' && row.reason === 'not_listed' && row.retrying === false)
  if (!unavailable(result.y2b.unknownChannel)) problems.push('Y2ⓑ 없는 채널')
  if (!unavailable(result.y2b.shellPane)) problems.push('Y2ⓑ 셸 pane')
  if (result.y2b.shellListed) problems.push('Y2ⓑ 셸 pane 이 목록에 있다')
  if (!(result.y2a.some((row) => row.type === 'chat.page' && row.mode === 'reset' && row.items > 0) && result.y2a.some((row) => row.type === 'chat.items'))) problems.push('Y2ⓐ 페이지·push')
  if (result.y9cRevoke.closeCode !== 4003 || result.y9cRevoke.framesAfter !== 0 || result.y9cRevoke.liveReceived < 1) problems.push('Y9ⓒ 해지')
  if (result.y9cReplaced.oldCloseCode !== 4006 || result.y9cReplaced.oldFramesAfter !== 0 || result.y9cReplaced.newReceived < 1) problems.push('Y9ⓒ replaced')
  const pass = problems.length === 0
  writeJson(path.join(path.resolve(args.out), 'gate-isolated.json'), { measuredAt: new Date().toISOString(), pass, problems, result })
  console.log(JSON.stringify({ pass, problems, result }))
  process.exit(pass ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await revokeAll(ROOT).catch(() => {})
  process.exit(1)
})
