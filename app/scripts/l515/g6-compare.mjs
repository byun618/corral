// LIFE-515 G6 — 사용자 설정 전=후 대조(fix1 R1-01). 시작 snapshot(파일)과 지금(수집기 g6-hash.sh 를 돌려 얻은 snapshot)을 견준다.
// - 수집기 종료코드 ≠ 0 · 빈 snapshot · 형식이 깨진 줄 · 고정 파일 줄(해시 또는 `absent`) 누락 → 즉시 실패(대조하지 않는다).
// - 엄격 범위 경로의 **합집합**으로 견준다 — 시작에만 있음 = 삭제, 지금만 있음 = 추가, 둘 다 있고 줄이 다름 = 수정(부재 ↔ 존재 포함).
// - 런타임 제외는 q1 경로 규칙 하나뿐: `~/.grok/` 아래에서 config.toml·trusted_folders.toml·hooks/ 가 아닌 경로(작업 시작 snapshot 이 넓은 범위로 찍힌 옛 형식일 때만 생긴다).
// 종료코드: 0 = 전=후 같음 · 1 = 실패(차이 또는 snapshot/수집기 오류 — 출력 첫 줄이 사유).
// 사용(저장소 루트): node app/scripts/l515/g6-compare.mjs <시작 snapshot> <지금 snapshot 을 쓸 경로>
//   수집기 바꾸기(자체 검사용): 환경변수 L515_G6_COLLECTOR=<sh 스크립트>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const UD = '~/Library/Application Support/corral'
export const FIXED_PATHS = [
  '~/.orca/keybindings.json', '~/.claude/settings.json', '~/.codex/config.toml', '~/.grok/config.toml', '~/.grok/trusted_folders.toml',
  `${UD}/settings.json`, `${UD}/keybindings.json`,
]
// 링크 줄은 경로 뒤에 ` -> <대상>` 이 붙는다(fix2 R2-02). 줄 전체를 견주므로 대상 경로가 바뀌어도, 대상 내용이 바뀌어도 「수정」 이다.
const HASH_LINE = /^([0-9a-f]{64}) {2}(\d+)B {2}(~\/.+?)(?: -> (.+))?$/
const ABSENT_LINE = /^absent {2}(~\/.+)$/

/** q1 — 엄격 범위 안인가. `~/.grok/` 아래는 설정 두 개와 hooks 만. */
export function inStrictScope(file) {
  if (!file.startsWith('~/.grok/')) return true
  return file === '~/.grok/config.toml' || file === '~/.grok/trusted_folders.toml' || file.startsWith('~/.grok/hooks/')
}

/** snapshot 글 → { ok, entries: Map<경로, 줄>, excluded: 경로[] } 또는 { ok:false, reason }. */
export function parseSnapshot({ text, label }) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return { ok: false, reason: `${label}: 빈 snapshot` }
  const entries = new Map()
  const excluded = []
  for (const line of lines) {
    const hit = HASH_LINE.exec(line) ?? ABSENT_LINE.exec(line)
    if (hit === null) return { ok: false, reason: `${label}: 형식이 깨진 줄 「${line}」` }
    const file = hit.length === 5 ? hit[3] : hit[1]
    if (!inStrictScope(file)) { excluded.push(file); continue }
    if (entries.has(file)) return { ok: false, reason: `${label}: 같은 경로가 두 번 「${file}」` }
    entries.set(file, line)
  }
  const missing = FIXED_PATHS.filter((file) => !entries.has(file))
  if (missing.length > 0) return { ok: false, reason: `${label}: 고정 파일 줄(해시 또는 absent) 없음 — ${missing.join(' · ')}` }
  return { ok: true, entries, excluded }
}

/** 두 snapshot 의 경로 합집합 대조 → 줄 목록과 차이 수. */
export function compareSnapshots({ before, after }) {
  const files = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()
  const rows = files.map((file) => {
    const was = before.entries.get(file)
    const now = after.entries.get(file)
    if (was === now) return { ok: true, text: `✔ 전=후 ${file}${now.startsWith('absent') ? ' (없음 유지)' : ''}` }
    if (now === undefined) return { ok: false, text: `✘ 삭제 ${file} — 시작: ${was}` }
    if (was === undefined) return { ok: false, text: `✘ 추가 ${file} — 지금: ${now}` }
    return { ok: false, text: `✘ 수정 ${file} — 시작: ${was} · 지금: ${now}` }
  })
  return { rows, differences: rows.filter((row) => !row.ok).length }
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2)
  if (beforePath === undefined || afterPath === undefined) throw new Error('사용: g6-compare.mjs <시작 snapshot> <지금 snapshot 경로>')
  const collector = process.env.L515_G6_COLLECTOR ?? path.join(HERE, 'g6-hash.sh')
  const run = spawnSync('sh', [collector], { encoding: 'utf8' })
  fs.writeFileSync(afterPath, run.stdout ?? '')
  if (run.status !== 0) {
    console.log(`✘ 수집기 실패 — ${collector} 종료코드 ${run.status ?? run.signal}${run.stderr ? ` · ${run.stderr.trim()}` : ''}`)
    process.exit(1)
  }
  const before = parseSnapshot({ text: fs.readFileSync(beforePath, 'utf8'), label: `시작 ${beforePath}` })
  const after = parseSnapshot({ text: run.stdout, label: `지금 ${afterPath}` })
  for (const parsed of [before, after]) {
    if (!parsed.ok) { console.log(`✘ snapshot 오류 — ${parsed.reason}`); process.exit(1) }
  }
  const { rows, differences } = compareSnapshots({ before, after })
  console.log(differences === 0 ? `전=후 같음 — 엄격 범위 ${rows.length}경로(합집합)` : `✘ 차이 ${differences}건 — 엄격 범위 ${rows.length}경로(합집합)`)
  for (const row of rows) console.log(row.text)
  const excluded = [...before.excluded, ...after.excluded]
  if (excluded.length > 0) console.log(`(대조 아님 — q1 런타임 경로) ${excluded.length}줄: ${[...new Set(excluded)].join(' · ')}`)
  process.exit(differences === 0 ? 0 : 1)
}

if (process.argv[1] === new URL(import.meta.url).pathname) main()
