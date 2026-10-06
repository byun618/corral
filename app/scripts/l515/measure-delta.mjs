// LIFE-515 K6ⓐ — 측정 도구 회차 둘(이전 일감의 마지막 `+` 메뉴 회차 ↔ 이 회차)의 차이 행을 견준다. 「새로 생긴 차이」 와 「사라진 차이」 를 낸다.
// 행 열쇠 = 상태 · 단위 id · 순번 · 차이 종류 · 속성 · 양쪽 값. 판정이 아니라 분류 재료다(새 차이가 「Agent 설정…」 행·순서·칩뿐인지 사람이 본다).
// 사용: node app/scripts/l515/measure-delta.mjs <이전 회차 폴더> <이 회차 폴더> [영역=tabmenu]
import fs from 'node:fs'
import path from 'node:path'
const [beforeDir, afterDir, area = 'tabmenu'] = process.argv.slice(2)
const keysOf = (dir) => {
  const out = new Map()
  for (const file of fs.readdirSync(dir).filter((name) => name.startsWith(`${area}-`) && name.endsWith('-diff.json'))) {
    const state = file.slice(area.length + 1, -'-diff.json'.length)
    const diff = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    for (const finding of diff.findings ?? []) {
      const key = JSON.stringify({ state, ...finding })
      out.set(key, { state, ...finding })
    }
  }
  return out
}
const before = keysOf(beforeDir)
const after = keysOf(afterDir)
const added = [...after].filter(([key]) => !before.has(key)).map(([, row]) => row)
const removed = [...before].filter(([key]) => !after.has(key)).map(([, row]) => row)
console.log(`이전 ${before.size}건 · 이번 ${after.size}건 · 새로 생김 ${added.length} · 사라짐 ${removed.length}`)
for (const row of added) console.log(`+ ${JSON.stringify(row).slice(0, 700)}`)
for (const row of removed) console.log(`- ${JSON.stringify(row).slice(0, 700)}`)
