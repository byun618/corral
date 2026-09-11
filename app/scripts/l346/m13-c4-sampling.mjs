// M13 — C4 보강: **1회차 계기가 그 창 안을 들여다본 적이 있는가.**
//
// C4 를 고치자 ⓑ(`pane.close` 경로)가 5/5 로 "처음에는 어긋났다" 가 됐다. 그런데 수정 1회차의
// 계기는 40ms 폴링이었고 드러난 창은 ~105ms 다 — 해상도만으로는 설명이 안 된다. 그래서
// **해상도 이야기를 쓰기 전에** 두 회차의 앱 로그에서 *언제 corral 을 떴는지* 를 직접 센다.
//
// 근거는 두 태그다: `control.cmd{"cmd":"state"}` (하네스가 corral 을 뜬 순간)와
// `push.applied` (corral 이 그 pane 의 종료를 실제로 적용한 순간). ⓑ 는 하네스가 herdr 에
// 직접 걸어서 앱 로그에 요청 기록이 없으므로, `life.close.request`(=ⓐ·ⓒ) 근처의 것을 뺀다.

import fs from 'node:fs'
import path from 'node:path'
import { RAW_ROOT, writeRaw } from './lib.mjs'

const read = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

function measure(file) {
  const lines = read(file)
  const states = lines.filter((item) => item.tag === 'control.cmd' && String(item.line).includes('"state"'))
  const closeRequests = lines.filter((item) => item.tag === 'life.close.request').map((item) => item.at)
  const applied = lines
    .filter((item) => item.tag === 'push.applied' && /pane_closed|pane_exited/.test(String(item.event)))
    // corral 이 스스로 건 종료(ⓐ·ⓒ)는 뺀다 — ⓑ 만 본다
    .filter((item) => !closeRequests.some((at) => Math.abs(at - item.at) < 3000))
  return applied.map((item) => {
    const before = states.filter((state) => state.at <= item.at).at(-1) ?? null
    const after = states.find((state) => state.at > item.at) ?? null
    return {
      note: item.note,
      '적용 직전에 corral 을 뜬 것이 몇 ms 전인가': before === null ? null : item.at - before.at,
      '적용 뒤 처음 corral 을 뜬 것이 몇 ms 뒤인가': after === null ? null : after.at - item.at,
      '창 안에서 뜬 적이 있나': before !== null && item.at - before.at < 105,
    }
  })
}

const out = {
  at: new Date().toISOString(),
  질문: '수정 1회차 계기는 herdr 가 버린 뒤 corral 이 따라오기 전 그 구간을 들여다본 적이 있는가',
  방법: 'app.ndjson 의 control.cmd(state) 시각과 push.applied(pane_closed) 시각을 맞대어 본다. ⓑ 회차만 — ⓐ·ⓒ 는 corral 이 종료를 걸어 life.close.request 가 남는다',
  '수정1회차(fix1)': measure(path.join(RAW_ROOT, 'fix1/_runs/m5-consistency/app.ndjson')),
  '수정2회차(fix2)': measure(path.join(RAW_ROOT, 'fix2/_runs/m5-consistency/app.ndjson')),
}
const summarise = (rows) => ({
  회차수: rows.length,
  '창 안에서 뜬 회차': rows.filter((row) => row['창 안에서 뜬 적이 있나']).length,
  '적용 직전 corral 관측 간격ms': rows.map((row) => row['적용 직전에 corral 을 뜬 것이 몇 ms 전인가']),
})
out.판정 = {
  'fix1 계기': summarise(out['수정1회차(fix1)']),
  'fix2 계기': summarise(out['수정2회차(fix2)']),
  결론:
    '수정 1회차의 ⓑ 회차들은 corral 을 **push 가 적용된 뒤에야** 떴다 (직전 관측이 0.5~1.2초 전). ' +
    '그 회차의 `처음부터일치: true` 는 "창이 없었다" 가 아니라 "창이 닫힌 뒤에 봤다" 는 뜻이다. ' +
    '수정 2회차는 같은 폴에서 양쪽을 떠서 창을 가로지른다. 창의 폭이 두 회차에 같았는지는 ' +
    '회차가 하나씩이라 이 자료로 말할 수 없다.',
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('c4-sampling-evidence.json', out)
