// LIFE-571 G4·G5 — 개발 실행 창에 Chromium 입력 경로(control `key`/`type` = webContents.sendInputEvent)로 키를 넣고,
// 렌더러 입력 링(term-read 의 `inputs`)·버퍼·스크린샷을 남긴다. OS 입력·입력 소스는 건드리지 않는다(02-kickoff 격리 4).
// 사용: node keys.mjs <ctl.sock> <out 폴더> <걸음...>
//   type:<글자열> | key:<KeyCode>[+shift][+alt][+control][+meta] | wait:<ms> | term:<이름> | shot:<이름> | mark | ring:<이름>
//   mark = 지금 입력 링 길이를 기억, ring:<이름> = mark 뒤에 쌓인 입력 링 항목만 JSON 으로(바이트는 JSON 이스케이프로 그대로 보인다).
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out, ...steps] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const read = async () => {
  const res = await rpc(sock, { cmd: 'term-read' })
  if (!res.ok) throw new Error(`term-read 실패 ${JSON.stringify(res).slice(0, 200)}`)
  return res.term
}
// 입력 링은 상한에서 앞을 잘라 내므로 길이 대신 마지막 항목의 at 으로 기준을 잡는다.
let markAt = 0
for (const step of steps) {
  const [name, arg] = step.includes(':') ? [step.slice(0, step.indexOf(':')), step.slice(step.indexOf(':') + 1)] : [step, '']
  if (name === 'wait') { await new Promise((resolve) => setTimeout(resolve, Number(arg))); continue }
  if (name === 'type') { console.log(step, JSON.stringify(await rpc(sock, { cmd: 'type', text: arg }))); continue }
  if (name === 'key') {
    const [keyCode, ...modifiers] = arg.split('+')
    console.log(step, JSON.stringify(await rpc(sock, { cmd: 'key', keyCode, modifiers })))
    continue
  }
  if (name === 'mark') { const t = await read(); markAt = t.inputs.at(-1)?.at ?? 0; console.log(`mark at=${markAt}`); continue }
  if (name === 'ring') {
    const t = await read()
    const items = t.inputs.filter((item) => item.at > markAt)
    fs.writeFileSync(path.join(out, `${arg}.ring.json`), JSON.stringify({ markAt, paneId: t.paneId, items }, null, 1))
    console.log(`ring ${arg} ${JSON.stringify(items.map((item) => item.data))}`)
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
    await rpc(sock, { cmd: 'shot', name: 'l571-frame-pump' }, 20_000)
    const res = await rpc(sock, { cmd: 'shot', name: `l571-${arg}` }, 20_000)
    if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res)}`)
    fs.copyFileSync(res.file, path.join(out, `${arg}.png`))
    console.log(`shot ${arg}.png`)
    continue
  }
  throw new Error(`모르는 걸음 ${step}`)
}
