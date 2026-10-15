// LIFE-604 R1-N — 「기대 종료코드 1(기준과 같은 실패만)」 행을 종료코드가 아니라 실패 목록으로 판정한다.
// 쓰기: node scripts/l604/expect-failures.mjs <vitest|lint> <이번 출력> <기준 출력 또는 기대 목록 파일>
//   vitest — 출력의 ` FAIL  …` 줄(파일·시험 경로) 집합을 비교한다. 기대 쪽이 vitest 출력이면 거기서, 아니면 한 줄에 하나씩 적은 목록.
//   lint   — eslint stylish 출력에서 (파일, 규칙) 묶음별 개수를 뽑아 비교한다. 파일 경로는 `app/` 아래 상대 경로로 맞춘다(worktree 위치 무관).
// 같으면 exit 0, 다르면 차이를 찍고 exit 1. 출력에서 아무것도 못 뽑으면 exit 2(빈 추출을 「차이 없음」 으로 읽지 않는다 — 양성 대조).
import fs from 'node:fs'

const [mode, currentPath, expectedPath] = process.argv.slice(2)
if ((mode !== 'vitest' && mode !== 'lint') || currentPath === undefined || expectedPath === undefined) {
  console.error('쓰기: expect-failures.mjs <vitest|lint> <이번 출력> <기준 출력|기대 목록>')
  process.exit(2)
}
const ESC = String.fromCharCode(27)
const plain = (text) => text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
const read = (file) => plain(fs.readFileSync(file, 'utf8'))

function vitestFails(text) {
  const lines = text.split('\n').map((line) => line.trimEnd())
  const found = lines.filter((line) => /^ FAIL {2}/.test(line)).map((line) => line.slice(' FAIL  '.length).trim())
  // 기대 목록 파일(출력이 아님) — 빈 줄·# 줄 빼고 한 줄에 하나.
  if (found.length === 0 && !text.includes('Test Files')) return lines.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  return found
}

function lintGroups(text) {
  const groups = new Map()
  let file = null
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('/')) { file = line.includes('/app/') ? line.slice(line.lastIndexOf('/app/') + '/app/'.length) : line; continue }
    const match = /^\s+\d+:\d+\s+(error|warning)\s+.*?\s{2,}(\S+)$/.exec(line)
    if (match === null || file === null) continue
    const key = `${file} :: ${match[2]}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return groups
}

if (mode === 'vitest') {
  const current = new Set(vitestFails(read(currentPath)))
  const expected = new Set(vitestFails(read(expectedPath)))
  if (current.size === 0 && expected.size === 0) { console.log('실패 줄을 하나도 못 뽑음 — 판정 불가'); process.exit(2) }
  const extra = [...current].filter((line) => !expected.has(line))
  const missing = [...expected].filter((line) => !current.has(line))
  console.log(`이번 실패 ${current.size} · 기대 ${expected.size}`)
  for (const line of extra) console.log(`+ ${line}`)
  for (const line of missing) console.log(`- ${line}`)
  console.log(extra.length === 0 && missing.length === 0 ? 'expect-failures(vitest): 같음' : 'expect-failures(vitest): 다름')
  process.exit(extra.length === 0 && missing.length === 0 ? 0 : 1)
}

const current = lintGroups(read(currentPath))
const expected = lintGroups(read(expectedPath))
if (current.size === 0 || expected.size === 0) { console.log(`(파일, 규칙) 묶음을 못 뽑음 — 이번 ${current.size} · 기준 ${expected.size}. 판정 불가`); process.exit(2) }
const keys = [...new Set([...current.keys(), ...expected.keys()])].sort()
const diff = keys.filter((key) => (current.get(key) ?? 0) !== (expected.get(key) ?? 0))
const total = (groups) => [...groups.values()].reduce((sum, count) => sum + count, 0)
console.log(`이번 ${current.size}묶음 ${total(current)}건 · 기준 ${expected.size}묶음 ${total(expected)}건`)
for (const key of diff) console.log(`${key}: 기준 ${expected.get(key) ?? 0} → 이번 ${current.get(key) ?? 0}`)
console.log(diff.length === 0 ? 'expect-failures(lint): 같음' : `expect-failures(lint): 다름 ${diff.length}묶음`)
process.exit(diff.length === 0 ? 0 : 1)
