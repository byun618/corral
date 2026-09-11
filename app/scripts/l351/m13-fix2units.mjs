// M13 — 수정 2회차의 단위 확인 (M-2 상태 구독 교체).
//
// **M-2 를 재는 방법을 왜 로그 집계로 잡았나.**
// 지적은 "옛 구독의 `onDrop('local')` 이 **새** 구독 참조를 지운다" 였고, 그 증거로 codex 가
// 든 것이 fix1 원자료의 집계였다 — `agent.sub.open` 44건 vs local drop 26건. 참조가 지워지면
// 다음 교체가 **옛 커넥션을 닫지 못한 채** 새 것을 열기 때문에 open 이 drop 보다 많아진다.
// 같은 자를 그대로 쓰되 **양쪽 회차에 댄다**: 이번 회차 로그와 fix1 이 커밋한 로그를 같은
// 코드로 세서, 숫자가 실제로 갈리는지 본다 (음성 대조).
//
// 이 스크립트는 앱을 띄우지 않는다 — N5 실행이 남긴 로그를 읽는다. 그래서 **N5 를 돌린 뒤에**
// 돌려야 한다 (`_runs/n5-consistency/app.ndjson`).

import fs from 'node:fs'
import path from 'node:path'
import { RAW_DIR, ROUND, readLog, writeRaw } from './lib.mjs'

const out = { at: new Date().toISOString(), 회차: ROUND }

/** 한 실행의 상태 구독 로그를 센다. */
function 집계(file) {
  if (!fs.existsSync(file)) return { 있나: false, file }
  const entries = readLog(file)
  const opens = entries.filter((entry) => entry.tag === 'agent.sub.open')
  const drops = entries.filter((entry) => entry.tag === 'agent.sub.dropped')
  const 실패 = entries.filter((entry) => entry.tag === 'agent.sub.failed')
  // 교체로 닫힌 것(`local`)만 센다 — 커넥션이 끊긴 drop 은 다른 이야기다.
  const localDrops = drops.filter((entry) => entry.reason === 'local')
  return {
    있나: true,
    file: path.relative(path.dirname(RAW_DIR), file),
    'agent.sub.open': opens.length,
    'agent.sub.dropped (전체)': drops.length,
    'agent.sub.dropped (local)': localDrops.length,
    'agent.sub.failed': 실패.length,
    // 수정 2회차부터 drop 에 `mine` 이 실린다. 옛 구독의 drop 은 `mine:false` 로 남고,
    // 그게 곧 "새 참조를 안 지웠다" 는 자취다 (fix1 로그에는 이 필드 자체가 없다).
    'mine:false (교체된 옛 구독)': drops.filter((entry) => entry.mine === false).length,
    'mine:true': drops.filter((entry) => entry.mine === true).length,
    '열고 못 닫은 수 (open − local drop)': opens.length - localDrops.length,
    표본: drops.slice(0, 3).map((entry) => ({ at: entry.at, reason: entry.reason, mine: entry.mine ?? '(필드 없음)' })),
  }
}

const 이번 = 집계(path.join(RAW_DIR, '_runs/n5-consistency/app.ndjson'))
const fix1 = 집계(path.join(path.dirname(RAW_DIR), 'fix1/_runs/n5-consistency/app.ndjson'))

out['M-2 상태 구독 교체'] = {
  질문: '구독을 교체할 때 옛 구독의 local drop 이 새 참조를 지우는가 (열고 못 닫는 커넥션이 쌓이는가)',
  이번회차: 이번,
  '수정1회차 (커밋된 원자료 — 음성 대조)': fix1,
  읽은것: {
    '이번 회차 로그가 있다': 이번.있나 === true,
    // 교체가 실제로 여러 번 일어난 실행이어야 이 자가 의미를 갖는다.
    '교체가 실제로 여러 번 일어났다': 이번['agent.sub.open'] >= 3,
    // 열린 것은 **전부** 닫힌다. 마지막 하나는 앱 종료(link.close)로 닫히므로 0 또는 1 이 정상이다.
    '열고 못 닫은 것이 0~1': 이번['열고 못 닫은 수 (open − local drop)'] <= 1,
    '옛 구독의 drop 이 mine:false 로 걸러진다': 이번['mine:false (교체된 옛 구독)'] > 0,
    '수정1회차는 열고 못 닫은 것이 여럿이었다 (케이스가 가른다)':
      fix1.있나 === true && fix1['열고 못 닫은 수 (open − local drop)'] > 1,
  },
}

out.판정 = Object.fromEntries(
  Object.entries(out)
    .filter(([, value]) => value !== null && typeof value === 'object' && value.읽은것 !== undefined)
    .flatMap(([key, value]) => Object.entries(value.읽은것).map(([name, ok]) => [`${key} · ${name}`, ok])),
)
out.어긋난것 = Object.entries(out.판정)
  .filter(([, value]) => value !== true)
  .map(([key]) => key)
console.log(JSON.stringify({ 판정: out.판정, 어긋난것: out.어긋난것 }, null, 2))
writeRaw('units-fix2-checks.json', out)
