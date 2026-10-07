// LIFE-519 K1ⓑ / K2ⓐⓑ — 소켓 주인 = CLI `serve`(제품 startRuntime → serveSocket), 시험용 지연(delay.cjs)을 NODE_OPTIONS 로 싣는다.
// 기동마다: 관측기(별도 프로세스, 촘촘한 lstat) + 이 프로세스의 폴링 클라이언트(제품 localCall 'status', 5ms 간격) → 오류 코드 집계.
// L519_APP 를 주면 그 app 디렉터리의 cli/corral.mjs(예: 기준 commit 을 내보내 빌드한 사본)로 serve 한다.
// 사용: node --import tsx k1b-serve.mjs <work=/tmp/l519w*> <기동 수> <지연 ms> <fail|pass> <out.json>
//   fail(기준 코드 양성 대조): 모든 기동에서 unsafe_permissions ≥1 그리고 관측기 loose ≥1 이면 exit 0
//   pass(고친 코드): 모든 기동에서 unsafe_permissions 0·관측기 loose 0·ok 응답 ≥1 이면 exit 0
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { header, guard, startObserver, stopPids, pause, APP, HERE, processesUsing } from './lib.mjs'
const { localCall, request } = await import('../../src/runtime/transport.ts')
const [work, countArg, delayArg, expect, out] = process.argv.slice(2)
guard(work)
fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true, mode: 0o700 })
const result = { ...header(), serveApp: process.env.L519_APP ?? APP, work, delayMs: Number(delayArg), expect, starts: [] }
for (let n = 1; n <= Number(countArg); n++) {
  const ud = path.join(work, `ud${n}`), endpoint = path.join(ud, 'runtime/rpc.sock')
  const observer = await startObserver(endpoint, path.join(work, `obs${n}.json`))
  const env = { ...process.env, CORRAL_USER_DATA: ud, L519_DELAY_PATH: endpoint, L519_DELAY_MS: delayArg, NODE_OPTIONS: `--require ${path.join(HERE, 'delay.cjs')}` }
  for (const key of ['CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION']) delete env[key]
  let stderr = ''
  const serve = spawn(process.execPath, [path.join(process.env.L519_APP ?? APP, 'cli/corral.mjs'), 'serve', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  serve.stderr.on('data', d => { stderr += d })
  const codes = {}, messages = new Set()
  let okAt = null, polls = 0
  const started = Date.now()
  while (Date.now() - started < 15000) {
    polls++
    try { const r = await localCall(endpoint, request({ command: 'status', flags: {}, args: [], cwd: '/tmp' }, undefined, 200), 200); codes[r.ok ? 'ok' : r.error?.code] = (codes[r.ok ? 'ok' : r.error?.code] ?? 0) + 1; if (r.ok && okAt === null) okAt = Date.now() - started }
    catch (error) { codes[error.code ?? 'throw'] = (codes[error.code ?? 'throw'] ?? 0) + 1; if (error.code === 'unsafe_permissions') messages.add(error.message) }
    if (okAt !== null && Date.now() - started > okAt + 200) break
    await pause(5)
  }
  const left = await stopPids([serve.pid])
  const obs = await observer.finish()
  const start = { n, endpoint, servePid: serve.pid, serveLeft: left, polls, codes, unsafeMessages: [...messages], okAtMs: okAt, delayLog: stderr.split('\n').filter(l => l.includes('[l519-delay]')), observer: { samples: obs.samples, intervalUs: obs.intervalUs, loose: obs.loose, firstSeen: obs.firstSeen, modes: obs.modes, transitions: obs.transitions } }
  result.starts.push(start)
  console.log(JSON.stringify({ n, codes, okAt, loose: obs.loose, firstSeen: obs.firstSeen, modes: obs.modes, delayLog: start.delayLog.length }))
}
const unsafe = s => s.codes.unsafe_permissions ?? 0
const pass = expect === 'fail'
  ? result.starts.every(s => unsafe(s) >= 1 && s.observer.loose >= 1 && s.delayLog.length === 1)
  : result.starts.every(s => unsafe(s) === 0 && s.observer.loose === 0 && (s.codes.ok ?? 0) >= 1 && s.delayLog.length === 1)
result.leftovers = processesUsing(work)
result.verdict = { expect, met: pass && result.leftovers.length === 0 && result.starts.every(s => s.serveLeft.length === 0) }
fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
console.log(JSON.stringify(result.verdict), 'leftovers', result.leftovers.length)
process.exit(result.verdict.met ? 0 : 1)
