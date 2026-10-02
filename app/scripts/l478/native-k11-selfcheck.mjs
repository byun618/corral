// LIFE-478 K11 드라이버 자기점검 (리뷰 r1 C-02ⓑ·C-06) — **OS 입력 없이** 돈다.
//
// ① 순수 판정: 단계 문지기(`stepGate`)·클립보드 허용 목록(`clipboardVerdict`)을 합성 입력으로.
// ② 드라이버 통째: 임시 ROOT(/tmp/l478n-selfcheck)에 「직전 단계 실패」 를 심고 실제 `native-k11.mjs` 를 돌린다.
//    cliclick·keypost·winctl 자리에는 **부른 인자를 적기만 하는 기록기**를 넣는다(L478_CLICLICK·L478_KEYPOST·L478_WINCTL) —
//    진짜 OS 입력 도구는 어떤 경우에도 불리지 않는다. 거절이면 기록기 호출 0 · 직전 기록 그대로여야 한다.
//    양성 대조: 같은 실패를 `ack` 로 확인한 뒤에는 같은 입력 단계가 문지기를 지나 활성화(winctl 기록기)까지 간다 — 막은 것이 문지기임을 보인다.
// 사용: node native-k11-selfcheck.mjs <결과 폴더>   종료코드 0 = 모든 검사 통과
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { clipboardVerdict, stepGate } from './native-k11-gate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(process.argv[2] ?? '.')
fs.mkdirSync(out, { recursive: true })
const checks = []
const check = (id, pass, observed) => checks.push({ id, pass, observed })

// ── ① 순수 판정 ──
const failed = { step: 'type', tag: '06-rename', ok: false }
const passed = { step: 'type', tag: '10-rename', ok: true }
check('gate-allow-first', stepGate({ last: null, step: 'click' }).kind === 'allow', stepGate({ last: null, step: 'click' }))
check('gate-allow-after-pass', stepGate({ last: passed, step: 'key' }).kind === 'allow', null)
for (const step of ['hover', 'click', 'rclick', 'dblclick', 'altclick', 'key', 'type', 'unfocused']) {
  const verdict = stepGate({ last: failed, step })
  check(`gate-refuse-input-after-fail:${step}`, verdict.kind === 'refuse', verdict)
}
for (const step of ['state', 'vscode']) check(`gate-allow-read-after-fail:${step}`, stepGate({ last: failed, step }).kind === 'allow', null)
check('gate-ack-wrong-tag', stepGate({ last: failed, step: 'ack', ackTag: '05-other' }).kind === 'refuse', stepGate({ last: failed, step: 'ack', ackTag: '05-other' }))
check('gate-ack-nothing', stepGate({ last: passed, step: 'ack', ackTag: '10-rename' }).kind === 'refuse', null)
check('gate-ack-right-tag', stepGate({ last: failed, step: 'ack', ackTag: '06-rename' }).kind === 'allow', null)

// `clipboard info` 실제 모양(R030 copy-path-47 앞에서 읽은 형식 목록) + 합성 형식들
const clips = [
  ['plain-text-real', '«class utf8», 1186, «class ut16», 1380, string, 6, Unicode text, 1378', 'allow'],
  ['empty', '', 'allow'],
  ['rtf', '«class RTF », 812, «class utf8», 20, «class ut16», 42, string, 20, Unicode text, 40', 'refuse'],
  ['html', '«class HTML», 300, «class utf8», 20, string, 20', 'refuse'],
  ['styled', '«class utf8», 20, scrap styles, 22, string, 20', 'refuse'],
  ['png', '«class PNGf», 10000, «class TIFF», 20000', 'refuse'],
  ['file-url', '«class furl», 40, «class utf8», 20, string, 20', 'refuse'],
]
for (const [id, info, want] of clips) {
  const verdict = clipboardVerdict(info)
  check(`clipboard-${id}`, verdict.kind === want, verdict)
}

// ── ② 드라이버 통째 (기록기) ──
const root = '/tmp/l478n-selfcheck'
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'repos'), { recursive: true })
fs.writeFileSync(path.join(root, 'app.pid'), '2147483646')
const calls = path.join(root, 'calls.log')
const recorder = (name, stdout) => {
  const file = path.join(root, name)
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${stdout === null ? '' : `echo '${stdout}'\n`}`, { mode: 0o755 })
  return file
}
const env = {
  ...process.env,
  L470_PRIVATE_DIR: '/tmp/l478-private',
  L478_CLICLICK: recorder('cliclick', null),
  L478_KEYPOST: recorder('keypost', null),
  // 활성화·창 목록 자리 — 빈 배열을 돌려준다(창 없음 → 드라이버는 「corral 창이 현재 화면에 없다」 로 입력 전에 멈춘다).
  L478_WINCTL: recorder('winctl', '[]'),
}
const rawd = path.join(out, 'driver')
const driver = (...args) => {
  const run = spawnSync(process.execPath, [path.join(here, 'native-k11.mjs'), root, rawd, ...args], { env, encoding: 'utf8', timeout: 30_000 })
  return { args, status: run.status, stderr: (run.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? '' }
}
const callLines = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((line) => line !== '') : [])
const lastStep = () => JSON.parse(fs.readFileSync(path.join(root, 'last-step.json'), 'utf8'))

fs.writeFileSync(path.join(root, 'last-step.json'), JSON.stringify({ step: 'type', tag: '06-rename', ok: false, at: 'injected', ack: null }) + '\n')
const refusedRuns = [driver('click', '07-x', '[data-x]'), driver('key', '07-enter', 'enter'), driver('type', '07-text', 'abc'), driver('rclick', '07-menu', '[data-x]')]
check('driver-refuses-input-after-fail', refusedRuns.every((run) => run.status !== 0 && run.stderr.includes('GATE')), refusedRuns)
check('driver-refusal-sends-nothing', callLines().length === 0, callLines())
check('driver-refusal-keeps-failed-record', lastStep().tag === '06-rename' && lastStep().ok === false, lastStep())
const wrongAck = driver('ack', '08-ack', '05-other')
check('driver-ack-wrong-tag-refused', wrongAck.status !== 0 && lastStep().ok === false, wrongAck)
const rightAck = driver('ack', '08-ack', '06-rename')
check('driver-ack-right-tag', rightAck.status === 0 && lastStep().ok === true && lastStep().ack === '06-rename', { run: rightAck, last: lastStep() })
check('driver-ack-sends-nothing', callLines().length === 0, callLines())
// 양성 대조 — 확인 뒤에는 문지기를 지나 활성화(기록기 winctl)까지 간다. 창이 없어 입력 전에 멈추므로 cliclick·keypost 는 여전히 0.
const afterAck = driver('click', '09-x', '[data-x]')
const lines = callLines()
check('control-after-ack-passes-gate', afterAck.status !== 0 && !afterAck.stderr.includes('GATE') && lines.some((line) => line.startsWith('winctl activate')), { run: afterAck, calls: lines })
check('control-no-os-input-tool-called', !lines.some((line) => line.startsWith('cliclick') || line.startsWith('keypost')), lines)
check('control-failure-recorded', lastStep().tag === '09-x' && lastStep().ok === false, lastStep())

fs.rmSync(root, { recursive: true, force: true })
const failedChecks = checks.filter((row) => !row.pass)
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ total: checks.length, failed: failedChecks.map((row) => row.id), checks }, null, 2) + '\n')
console.log(`[selfcheck] ${checks.length - failedChecks.length}/${checks.length}${failedChecks.length === 0 ? '' : ` — 실패 ${failedChecks.map((row) => row.id).join(', ')}`}`)
process.exit(failedChecks.length === 0 ? 0 : 1)
