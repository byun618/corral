// LIFE-580 L6 — claude 권한 대기 1회 실측(격리 인스턴스 안의 실제 claude pane). 대기 중 같은 순간의 세 가지를 남긴다:
//   ① pane 화면의 권한 대화상자(herdr `pane read` — 무엇을 기다리나)  ② main 상태의 그 pane `digest.tool`·`agentState`(제어 소켓 `state`)
//   ③ 폰 자리가 받은 목록의 그 채널(waiting·preview)
// 판정: digest.tool 이 대화상자의 도구·대상과 같고, 폰 미리보기가 그 도구·대상이다(아니면 `승인 대기` 문구여야 한다 — 그때는 미리보기 글 null).
// `--leave-open` 이면 대화상자를 열어 둔 채 끝낸다(에뮬레이터 캡처를 같은 상태에서 찍으려고). 아니면 `1`(이번만 허용)로 답하고 끝낸다.
// 사용(app/): node scripts/l580/l6-permission.mjs --root /tmp/l580g-x --fake /tmp/l580g-fx --pane w1:p1 --herdr-bin <격리 guard> --out <폴더> [--leave-open]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, ctl, herdrSession, phone, sleep, until, writeJson } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, pane: { type: 'string' }, 'herdr-bin': { type: 'string' }, out: { type: 'string' }, 'leave-open': { type: 'boolean', default: false }, file: { type: 'string', default: 'l6-probe.txt' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (!args.pane || !args.out || !args['herdr-bin'] || !fs.existsSync(args['herdr-bin'])) throw new Error('--pane · --out · --herdr-bin 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const socket = path.join(os.homedir(), '.config/herdr-dev/sessions', herdrSession(args.root), 'herdr.sock')
const env = { ...process.env, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: args['herdr-bin'], HERDR_PANE_ID: '' }
const cli = (argv, timeout = 65_000) => spawnSync(args['herdr-bin'], argv, { env, encoding: 'utf8', timeout })
const OUT = path.resolve(args.out)
fs.mkdirSync(OUT, { recursive: true })

/** main 상태에서 그 pane 행을 찾는다(모양에 기대지 않고 paneId 로 훑는다). */
function findPane(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.paneId === args.pane && 'digest' in node) return node
  for (const value of Object.values(node)) {
    const hit = findPane(value)
    if (hit) return hit
  }
  return null
}

let last = null
const client = await phone(args.root, {
  onList: ({ message }) => {
    if (!message.list.available) return
    for (const repo of message.list.repos) for (const task of repo.tasks) for (const c of task.channels) if (c.id === args.pane) last = { seq: message.seq, dot: c.dot, waiting: c.waiting, preview: c.preview }
  },
})
cli(['pane', 'send-text', args.pane, `Use the Bash tool to run exactly: touch ${args.file}`], 10_000)
await sleep(300)
cli(['pane', 'send-keys', args.pane, 'Enter'], 10_000)
const seen = cli(['pane', 'wait-output', '--match', 'Do you want to proceed?', '--source', 'visible', '--timeout', '60000', args.pane])
if (seen.status !== 0) {
  console.error('권한 대화상자가 60초 안에 안 떴다')
  process.exit(1)
}
await until(() => (last?.waiting === 'approval' && last.preview?.text ? true : null), { timeoutMs: 10_000, label: '폰 approval 미리보기' }).catch(() => null)
const screen = cli(['pane', 'read', args.pane], 10_000).stdout.split('\n').filter((line) => line.trim() !== '').slice(-14).join('\n')
const state = await ctl(args.root, { cmd: 'state' })
const row = findPane(state.state)
const result = {
  at: new Date().toISOString(),
  pane: args.pane,
  screen,
  desktop: row === null ? null : { agent: row.agent ?? null, agentStatus: row.agentStatus ?? null, agentState: row.agentState ?? null, digestTool: row.digest?.tool ?? null },
  phone: last,
}
const tool = result.desktop?.digestTool
result.judge = {
  digestToolIsWaitedTool: tool?.name === 'Bash' && typeof tool.input === 'string' && tool.input.includes(`touch ${args.file}`) && screen.includes(`touch ${args.file}`),
  phonePreview: last?.preview ?? null,
  phonePreviewIsTool: last?.waiting === 'approval' && last.preview?.kind === 'approval' && last.preview?.text === `Bash · touch ${args.file}`,
}
writeJson(path.join(OUT, 'l6-permission.json'), result)
console.log(JSON.stringify(result.judge))
if (!args['leave-open']) {
  cli(['pane', 'send-keys', args.pane, '1'], 10_000)
  console.log('답: 1(이번만 허용)')
}
await client.close()
process.exit(result.judge.digestToolIsWaitedTool && result.judge.phonePreviewIsTool ? 0 : 1)
