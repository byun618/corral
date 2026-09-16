// R26 — **`before-input-event` 에서 `preventDefault()` 하면 그 뒤 keyUp 이 사라진다** (실측).
//
// 왜 재나: ③ MRU 의 확정 신호가 `Control` **keyup** 이다 (F3-2). 기준서 F3-1 은 캡처 경로로
// main 의 `before-input-event` 를 권했는데, 거기서 `⌃Tab` 을 삼키면 확정 신호가 같이 죽는다.
// "안 왔다" 를 추측으로 적지 않으려고 세 단계를 같은 창에서 나눠 잰다.
//
//   ① 기준선          — 아무도 안 막은 상태에서 `Shift` keyUp ×3
//   ② `⌘W` 를 삼킨 뒤 — main 이 `preventDefault()` 하는 유일한 키. 그 뒤 `Shift` keyUp ×3
//   ③ `⌃Tab` 뒤       — main 은 이 키를 **안 막는다**(렌더러 캡처가 잡는다). `Control` keyUp ×3
//
// 판별자는 앱이 남기는 `input.raw` 로그다 (계측 실행에서만 붙는 줄, R5). 페이지 쪽에도
// keyup 리스너를 달아 **둘 다** 못 받는다는 것을 같이 적는다.
//
// 격리: `life373-` 세션 전용. 레포를 안 붙이므로 화면은 빈 목록이고, 재는 것은 키 배달뿐이다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-r26-'))
const app = await startApp({
  name: 'r26-keyup',
  env: { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') },
  registryFile: path.join(RUN_DIR, 'repos.json'),
})
await sleep(3000)
await app.send({
  cmd: 'eval',
  code: `(() => { window.__k = []; document.addEventListener('keyup', (e) => window.__k.push(e.key), true); return 1 })()`,
})

const send = async (keyCode, modifiers, type) => {
  await app.send({ cmd: 'key', keyCode, modifiers, type })
  await sleep(700)
}
const mainSaw = () => app.entries().filter((e) => e.tag === 'input.raw').map((e) => `${e.type}:${e.key}`)
const pageSaw = async () => (await app.send({ cmd: 'eval', code: '(() => window.__k)()' })).result

const 결과 = { at: new Date().toISOString(), 세션: SESSION, 단계: [] }
const phase = async (label, steps, 기대) => {
  const mainBefore = mainSaw().length
  const pageBefore = (await pageSaw()).length
  for (const [keyCode, modifiers, type] of steps) await send(keyCode, modifiers, type)
  await sleep(1500)
  const row = {
    label,
    보낸것: steps.map(([k, m, t]) => `${t}:${k}${m.length > 0 ? `(${m.join('+')})` : ''}`),
    main이본것: mainSaw().slice(mainBefore),
    페이지가본것: (await pageSaw()).slice(pageBefore),
    기대,
  }
  결과.단계.push(row)
  console.log('#', label, '| main', JSON.stringify(row.main이본것), '| page', JSON.stringify(row.페이지가본것))
  return row
}

const 기준선 = await phase('① 기준선', [['Shift', [], 'keyUp'], ['Shift', [], 'keyUp'], ['Shift', [], 'keyUp']], 'keyUp 3개 다 온다')
const 삼킨뒤 = await phase(
  '② ⌘W(preventDefault) 뒤',
  [['W', ['meta'], 'keyDown'], ['Shift', [], 'keyUp'], ['Shift', [], 'keyUp'], ['Shift', [], 'keyUp']],
  '억제가 사실이면 keyUp 이 0개다',
)
const 안막은뒤 = await phase(
  '③ ⌃Tab(main 이 안 막음) 뒤',
  [['Tab', ['control'], 'keyDown'], ['Control', [], 'keyUp'], ['Control', [], 'keyUp'], ['Control', [], 'keyUp']],
  '렌더러로 옮긴 경로라면 keyUp 이 온다',
)

const keyUps = (row) => row.main이본것.filter((line) => line.startsWith('keyUp')).length
결과.판정 = {
  기준선_keyUp: keyUps(기준선),
  삼킨뒤_keyUp: keyUps(삼킨뒤),
  안막은뒤_keyUp: keyUps(안막은뒤),
  억제사실인가: keyUps(기준선) > 0 && keyUps(삼킨뒤) === 0,
  옮긴경로살아있나: keyUps(안막은뒤) > 0,
}
console.log('판정:', JSON.stringify(결과.판정))
await app.stop()
writeRaw('f3-keyup-suppression.json', 결과)
