// LIFE-470 수정 라운드 1 (R1-01) — 원자료 익명화 규칙 하나. 커밋되는 raw 에는 사용자 레포·워크트리 경로·브랜치 이름·홈 경로를 싣지 않는다.
//   · 사용자 레포 root → `repo#N`, 그 레포의 연결 워크트리 path → `wt#N`, 브랜치 이름(화면 읽기의 `branches` 값) → `br#N`
//   · 나머지 홈 접두(`$HOME`) → `~`
// 대응표(원래 값 → 키)는 **비공개 임시 위치**(`/tmp/l470-private/anon-map.json`)에만 둔다 — 같은 값은 언제나 같은 키(회차를 넘어 대조 가능).
// 사용자 ui-prefs 는 값을 싣지 않는다 — `prefsSummary` 가 키 구성·타입·개수·해시·(기준과) 같음/다름만 만든다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 비공개 위치 — `L470_PRIVATE_DIR` 은 자기점검(`anon-check.mjs`)이 사용자 대응표를 건드리지 않으려고 쓴다(`/tmp/l470*` 만). */
export const PRIVATE_DIR = process.env.L470_PRIVATE_DIR ?? '/tmp/l470-private'
const MAP_FILE = path.join(PRIVATE_DIR, 'anon-map.json')
const HOME = os.homedir()

/** 대응표 — `{ repo: {값: 키}, wt: {…}, br: {…} }`. 없으면 빈 표. 익명 키를 원래 값으로 올린 별칭은 접는다(`collapseAliases`). */
export function loadMap() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
    return { repo: collapseAliases(parsed.repo ?? {}), wt: collapseAliases(parsed.wt ?? {}), br: collapseAliases(parsed.br ?? {}) }
  } catch {
    return { repo: {}, wt: {}, br: {} }
  }
}

/**
 * R2-02 이전 대응표 복구 — 예전 코드는 이미 처리한 raw 를 다시 돌리면 익명 키(`repo#1`)를 원래 값으로 올려 `repo#1 → repo#2` 같은 별칭을
 * 만들었다. 그 raw 는 별칭 끝 키(`repo#2`)로 적혀 있으므로 원래 값을 **사슬 끝 키**로 바로 잇고 별칭은 뺀다 — raw 바이트는 그대로이고,
 * 별칭이 다른 출처의 정상 익명 키를 고쳐 쓰는 일이 없어진다.
 */
function collapseAliases(table) {
  const out = {}
  for (const [value, key] of Object.entries(table)) {
    if (isAnonymized(value)) continue
    let final = key
    for (let hop = 0; table[final] !== undefined && hop < 100; hop++) final = table[final]
    out[value] = final
  }
  return out
}

export function saveMap(map) {
  fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), { mode: 0o600 })
}

/**
 * 이미 익명화된 값 — 익명 키(`repo#N`·`wt#N`·`br#N`)이거나 홈 접두를 `~` 로 바꾼 경로. 원래 값으로 다시 올리지 않는다(LIFE-470 R2-02) —
 * 그래야 이미 처리한 raw 를 다시 돌려도 바이트가 그대로다(멱등). 원래 값은 절대 경로이고 git 브랜치 이름에는 `~` 가 올 수 없어 겹치지 않는다.
 */
export function isAnonymized(value) {
  return /^(repo|wt|br)#\d+$/.test(value) || value.startsWith('~')
}

/** 값의 키 — 처음 보는 값이면 다음 번호를 붙인다(표를 바꾼다 — 호출부가 `saveMap`). 이미 익명화된 값은 그대로 돌려준다(R2-02). */
export function keyFor(input) {
  if (isAnonymized(input.value)) return input.value
  const table = input.map[input.kind]
  // 다음 번호 = 쓰인 번호 최댓값 + 1 — 별칭을 접은 표는 번호가 비어 있어 개수 + 1 이면 이미 쓴 키와 겹친다.
  const next = () => Math.max(0, ...Object.values(table).map((key) => Number(key.split('#')[1]))) + 1
  if (table[input.value] === undefined) table[input.value] = `${input.kind}#${next()}`
  return table[input.value]
}

/** 글 안의 사용자 경로를 키로 — 긴 경로부터 바꾼다(워크트리 path 가 레포 root 로 시작하므로). 그다음 홈 접두. */
export function anonymizeText(input) {
  const pairs = [...Object.entries(input.map.repo), ...Object.entries(input.map.wt)].sort((a, b) => b[0].length - a[0].length)
  let text = input.text
  for (const [value, key] of pairs) {
    text = text.split(value).join(key)
    // macOS 는 /tmp 를 /private/tmp 로도 적는다 — 사용자 경로에는 해당 없지만 realpath 형태도 함께 바꾼다.
    text = text.split(`/private${value}`).join(key)
  }
  return text.split(HOME).join('~')
}

/** JSON 값 전체 익명화 — `branches` 객체의 값(브랜치 이름)은 `br#N`, 그 밖의 문자열은 `anonymizeText`. */
export function anonymizeValue(input) {
  const walk = (value, parentKey) => {
    if (typeof value === 'string') return anonymizeText({ text: value, map: input.map })
    if (Array.isArray(value)) return value.map((item) => walk(item, null))
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        const anonKey = anonymizeText({ text: key, map: input.map })
        out[anonKey] = parentKey === 'branches' && typeof item === 'string' ? keyFor({ map: input.map, kind: 'br', value: item }) : walk(item, key)
      }
      return out
    }
    return value
  }
  return walk(input.value, null)
}

/** 화면 읽기에서 사용자 레포·워크트리 path 를 표에 올린다(키 부여만). 레포 root 는 그 레포의 주 체크아웃 path 와 같다. */
export function registerRead(input) {
  for (const group of input.read?.groups ?? []) {
    keyFor({ map: input.map, kind: 'repo', value: group.root })
    for (const worktree of group.worktrees) if (worktree !== group.root) keyFor({ map: input.map, kind: 'wt', value: worktree })
  }
  for (const worktree of input.read?.all ?? []) if (input.map.repo[worktree] === undefined) keyFor({ map: input.map, kind: 'wt', value: worktree })
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

/**
 * ui-prefs 요약 — 값 없이 키별 타입·개수·해시와, 기준(`base`, 보통 회차 전 백업)과의 같음/다름. 해시는 값 JSON 의 sha256 이라
 * 같은 값끼리 대조는 되지만 값은 드러나지 않는다.
 */
export function prefsSummary(input) {
  const keys = [...new Set([...Object.keys(input.prefs), ...Object.keys(input.base ?? {})])].sort()
  const fields = {}
  for (const key of keys) {
    const value = input.prefs[key]
    const type = value === undefined ? 'absent' : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const count = Array.isArray(value) ? value.length : type === 'object' ? Object.keys(value).length : null
    fields[key] = {
      type,
      count,
      sha256: value === undefined ? null : sha256(JSON.stringify(value)),
      sameAsBase: input.base === undefined ? null : JSON.stringify(value) === JSON.stringify(input.base[key]),
    }
  }
  return { keys: Object.keys(input.prefs).sort(), fileSha256: input.fileSha256 ?? null, fields }
}
