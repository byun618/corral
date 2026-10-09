// LIFE-571 G4·G5 — 개발 실행 창에 Chromium 입력 경로(control `key`/`type` = webContents.sendInputEvent)로 키를 넣고,
// 렌더러 입력 링(term-read 의 `inputs`)·버퍼·스크린샷을 남긴다. OS 입력·입력 소스는 건드리지 않는다(02-kickoff 격리 4).
// 판정은 종료코드로 낸다(r1 L3): 기대 걸음(expect-ring·screen·noscreen·waitscreen·txdelta)이 하나라도 어긋나면 1,
// rpc 실패(ok 아님·빈 결과)는 그 자리에서 2. 걸음마다의 판정은 <out>/<check 이름>.checks.json 에 남는다.
// 사용: node keys.mjs <ctl.sock> <out 폴더> <걸음...>
//   type:<글자열> | key:<KeyCode>[+shift][+alt][+control][+meta] | wait:<ms> | term:<이름> | shot:<이름>
//   mark                         지금 입력 링의 마지막 시각을 기억
//   ring:<이름>                  mark 뒤 입력 링 항목을 <이름>.ring.json 으로
//   expect-ring:<이름>=<JSON 배열> mark 뒤 입력 링의 data 목록이 정확히 같아야 한다(빈 목록이면 기대도 [] 여야 한다) — ring 파일도 남긴다
//   screen:<이름>=<정규식>       지금 버퍼 줄 중 하나가 맞아야 한다   | noscreen:<이름>=<정규식> 맞는 줄이 없어야 한다
//   waitscreen:<ms>=<정규식>     그 시간 안에 맞는 줄이 나와야 한다(에이전트 기동 대기)
//   txmark:<claude|codex>        세션 기록 오라클(transcripts.mjs)의 지금 user 메시지 수를 기억
//   txdelta:<claude|codex>=<n>   txmark 뒤 늘어난 수가 정확히 n 이어야 한다. cwd 는 L571_CWD, 뺄 세션은 L571_EXCLUDE
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { countUserMessages } from './transcripts.mjs'

const [sock, out, ...steps] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const checks = []
const checkName = process.env.L571_CHECK ?? 'run'
const save = () => fs.writeFileSync(path.join(out, `${checkName}.checks.json`), JSON.stringify(checks, null, 1))
const abort = (message) => { checks.push({ step: 'rpc', pass: false, message }); save(); console.error(`ABORT ${message}`); process.exit(2) }
const call = async (request, timeout) => {
  let res
  try { res = await rpc(sock, request, timeout) } catch (error) { abort(`${request.cmd} 예외 ${error.message}`) }
  if (!res || res.ok !== true) abort(`${request.cmd} 실패 ${JSON.stringify(res).slice(0, 300)}`)
  return res
}
const read = async () => {
  const term = (await call({ cmd: 'term-read' })).term
  if (!term || !Array.isArray(term.inputs) || !Array.isArray(term.lines)) abort('term-read 빈 결과')
  return term
}
const record = (step, pass, detail) => { checks.push({ step, pass, ...detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail).slice(0, 300)}`) }
const pane = () => ({ cwd: process.env.L571_CWD, exclude: process.env.L571_EXCLUDE })
const split = (arg) => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]

// 입력 링은 상한에서 앞을 잘라 내므로 길이 대신 마지막 항목의 at 으로 기준을 잡는다.
let markAt = 0
const txMarks = {}
for (const step of steps) {
  const [name, arg] = step.includes(':') ? [step.slice(0, step.indexOf(':')), step.slice(step.indexOf(':') + 1)] : [step, '']
  if (name === 'wait') { await new Promise((resolve) => setTimeout(resolve, Number(arg))); continue }
  if (name === 'type') { console.log(step, JSON.stringify(await call({ cmd: 'type', text: arg }))); continue }
  if (name === 'key') {
    const [keyCode, ...modifiers] = arg.split('+')
    console.log(step, JSON.stringify(await call({ cmd: 'key', keyCode, modifiers })))
    continue
  }
  if (name === 'mark') { const t = await read(); markAt = t.inputs.at(-1)?.at ?? 0; console.log(`mark at=${markAt}`); continue }
  if (name === 'ring' || name === 'expect-ring') {
    const [label, expectedJson] = name === 'ring' ? [arg, null] : split(arg)
    const t = await read()
    const items = t.inputs.filter((item) => item.at > markAt)
    fs.writeFileSync(path.join(out, `${label}.ring.json`), JSON.stringify({ markAt, paneId: t.paneId, items }, null, 1))
    const actual = items.map((item) => item.data)
    if (expectedJson === null) { console.log(`ring ${label} ${JSON.stringify(actual)}`); continue }
    const expected = JSON.parse(expectedJson)
    record(step, JSON.stringify(actual) === JSON.stringify(expected), { label, expected, actual })
    continue
  }
  if (name === 'screen' || name === 'noscreen') {
    const [label, pattern] = split(arg)
    const t = await read()
    const hits = t.lines.map((line) => line.trimEnd()).filter((line) => new RegExp(pattern).test(line))
    record(step, name === 'screen' ? hits.length > 0 : hits.length === 0, { label, pattern, hits })
    continue
  }
  if (name === 'waitscreen') {
    const [ms, pattern] = split(arg)
    const start = Date.now()
    let hits = []
    while (Date.now() - start < Number(ms)) {
      hits = (await read()).lines.map((line) => line.trimEnd()).filter((line) => new RegExp(pattern).test(line))
      if (hits.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    record(step, hits.length > 0, { pattern, waitedMs: Date.now() - start, hits })
    continue
  }
  if (name === 'txmark') {
    const { cwd, exclude } = pane()
    if (!cwd) abort('L571_CWD 없음')
    const now = countUserMessages({ agent: arg, cwd, since: Number(process.env.L571_TX_SINCE ?? 0), exclude })
    txMarks[arg] = now
    console.log(`txmark ${arg} total=${now.total} files=${now.files.length}`)
    continue
  }
  if (name === 'txdelta') {
    const [agent, n] = split(arg)
    const { cwd, exclude } = pane()
    const before = txMarks[agent]
    if (!before) abort(`txmark:${agent} 없이 txdelta`)
    const after = countUserMessages({ agent, cwd, since: before.since, exclude })
    record(step, after.total - before.total === Number(n), { agent, expectedDelta: Number(n), before: before.total, after: after.total, files: after.files })
    continue
  }
  if (name === 'term') {
    const t = await read()
    const lines = t.lines.map((line, y) => ({ y, line: line.trimEnd() })).filter((x) => x.line.length > 0)
    fs.writeFileSync(path.join(out, `${arg}.term.json`), JSON.stringify({ paneId: t.paneId, cursorX: t.cursorX, cursorY: t.cursorY, cols: t.cols, rows: t.rows, lines, inputs: t.inputs.slice(-16) }, null, 1))
    console.log(`term ${arg} cursor=${t.cursorX},${t.cursorY}`)
    continue
  }
  if (name === 'shot') {
    // 가려진 창은 rAF 가 멈춰 DOM 이 늦다 — 한 번 찍어 프레임을 밀고 다시 찍는다(LIFE-566 실측, c1 before/after 가 같은 그림이었다).
    await call({ cmd: 'shot', name: 'l571-frame-pump' }, 20_000)
    const res = await call({ cmd: 'shot', name: `l571-${arg}` }, 20_000)
    fs.copyFileSync(res.file, path.join(out, `${arg}.png`))
    console.log(`shot ${arg}.png`)
    continue
  }
  abort(`모르는 걸음 ${step}`)
}
save()
const failed = checks.filter((check) => !check.pass)
console.log(`checks ${checks.length - failed.length}/${checks.length} pass`)
process.exit(checks.length === 0 ? 0 : failed.length === 0 ? 0 : 1)
