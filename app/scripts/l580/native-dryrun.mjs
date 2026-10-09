// LIFE-580 R2-A4 — 네이티브 J5 절차(`native-cause.mjs` → `native-j5.mjs`)의 **격리 dry-run**. 설치본·실제 폰을 건드리지 않는다.
// 격리 개발 Electron(g-up.sh /tmp/l580g-*)의 격리 herdr 세션에 셸 pane 하나를 「전용 셸 pane」 으로 두고, 그 pane 의 환경을 흉내 내
// `native-cause.mjs --isolated` 를 띄운다(HERDR_BIN_PATH = 격리 guard 바이너리, HERDR_SOCKET_PATH = 격리 세션 소켓, HERDR_PANE_ID = 그 pane).
// 폰 자리는 Node 클라이언트이고, 받은 목록을 **폰 연결 기록과 같은 모양**(`list_recv` 줄)으로 써서 계산기에 넣는다.
// dry-run 은 절차가 도는지 보는 것이다 — 판정 회차가 아니다(전이 6회 · 간격 3초).
//
// 사용(app/ 에서): node scripts/l580/native-dryrun.mjs --root /tmp/l580g-d1 --fake /tmp/l580g-fd1 --herdr-bin <격리 guard herdr> --out <폴더>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, freshPane, herdrSession, phone, revokeAll, setMobile, sleep } from './lib.mjs'
import { computeNativeJ5 } from './native-j5.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, 'herdr-bin': { type: 'string' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined || args['herdr-bin'] === undefined || !fs.existsSync(args['herdr-bin'])) throw new Error('--out · --herdr-bin(격리 guard 바이너리) 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
fs.mkdirSync(OUT, { recursive: true })
const socket = path.join(os.homedir(), '.config/herdr-dev/sessions', herdrSession(ROOT), 'herdr.sock')

async function main() {
  await setMobile(ROOT, args.fake, true)
  const { paneId } = await freshPane(ROOT)
  const phoneLines = []
  let client = null
  client = await phone(ROOT, {
    onList: ({ message, recvAt }) => {
      const clock = client?.clockOffset() ?? null
      phoneLines.push(JSON.stringify({ at: new Date(recvAt).toISOString(), event: 'list_recv', seq: message.seq, serverAt: message.at, changedAt: message.changedAt, recvAt, offsetMs: clock?.offsetMs ?? null, rttMs: clock?.rttMs ?? null }))
    },
  })
  for (let i = 0; i < 5; i += 1) await client.ping()
  let pinging = true
  const pinger = (async () => {
    while (pinging) await client.ping().then(() => sleep(850))
  })()
  const causeFile = path.join(OUT, 'cause.ndjson')
  fs.rmSync(causeFile, { force: true })
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'native-cause.mjs'), '--out', causeFile, '--sequence', 'working,idle,blocked,working,idle,working', '--gap-ms', '3000', '--release', '--isolated', '--label', 'dryrun'], {
      env: { ...process.env, HERDR_BIN_PATH: args['herdr-bin'], HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: paneId },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`native-cause pid=${child.pid} pane=${paneId}`)
    child.stdout.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('exit', (code) => resolve(code))
  })
  await sleep(3_000)
  pinging = false
  await pinger
  fs.writeFileSync(path.join(OUT, 'phone.txt'), phoneLines.join('\n') + '\n')
  const result = computeNativeJ5({ phoneText: phoneLines.join('\n'), causeText: fs.readFileSync(causeFile, 'utf8') })
  fs.writeFileSync(path.join(OUT, 'native-j5.json'), JSON.stringify(result, null, 2) + '\n')
  for (const row of result.rows) console.log(`${row.i} ${row.state} ${row.status}${row.aMs != null ? ` ⓐ ${row.aMs}ms ⓑ ${row.bMs}ms` : ''}${row.why ? ` — ${row.why}` : ''}`)
  console.log(`dry-run native-cause exit ${exit} · 셀 수 있는 전이 ${result.counted} · 보류 ${result.held} · ⓐ 최대 ${result.maxAMs} · ⓑ 최대 ${result.maxBMs} → ${result.verdict}`)
  await client.close()
  await revokeAll(ROOT)
  await setMobile(ROOT, args.fake, false)
  process.exit(exit === 0 && result.verdict === '통과' ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
