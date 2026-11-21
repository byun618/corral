// 소스 제어 보기 (LIFE-683) — 순수 모델. 탐색기 허브의 같은 `git status --porcelain=v2 -z` 출력을 VS Code git 확장의 리소스 그룹대로 나눈다.
//
// · 분류는 VS Code `extensions/git/src/repository.ts` 3219-3252(d0adb05e725 — `??` 3219 · 충돌 3229-3235 · X 3238-3244 · Y 3246-3252, F2-02 정정): 충돌 XY → 병합 변경, 아니면 X → 스테이지된 변경, Y → 변경. 한 파일이
//   인덱스·작업 트리 둘 다 바뀌면 두 그룹에 각각 나온다. 추적 안 함은 `git.untrackedChanges: mixed`(기본) 대로 「변경」 에 섞는다.
//   의도적 차이 — X=`T`(스테이지된 형식 변경)는 VS Code switch 에 없어 목록에서 사라지지만 corral 은 스테이지 그룹에 T 로 둔다(D1).
// · 글자·색은 탐색기 배지와 같은 표(`explorer-git.ts` `GIT_DECORATION`) — 탐색기 `markOf` 는 건드리지 않는다(S10).
// · 클릭 대상은 VS Code `repository.ts` 532-694 `resolveChangeCommand`·`getLeftResource`·`getRightResource`·`getTitle` 그대로 — left 가 없으면 단일 열기,
//   있으면 diff. ref 는 HEAD·인덱스만(S7) — 충돌 단계(`~1`~`~3`)는 읽지 않는다(D1).
import type { GitMark } from './explorer-git.js'

export type ScmGroupId = 'merge' | 'index' | 'workingTree' | 'base'

export type ScmStatus =
  | 'INDEX_MODIFIED'
  | 'INDEX_ADDED'
  | 'INDEX_DELETED'
  | 'INDEX_RENAMED'
  | 'INDEX_COPIED'
  | 'INDEX_TYPE_CHANGED'
  | 'MODIFIED'
  | 'DELETED'
  | 'UNTRACKED'
  | 'INTENT_TO_ADD'
  | 'INTENT_TO_RENAME'
  | 'TYPE_CHANGED'
  | 'BOTH_DELETED'
  | 'ADDED_BY_US'
  | 'DELETED_BY_THEM'
  | 'ADDED_BY_THEM'
  | 'DELETED_BY_US'
  | 'BOTH_ADDED'
  | 'BOTH_MODIFIED'
  // LIFE-830 — base 대비 목록(`git diff --raw` 의 A·R) 전용. 나머지 글자는 위 값(MODIFIED·DELETED·TYPE_CHANGED·UNTRACKED·BOTH_MODIFIED)을 같이 쓴다.
  | 'ADDED'
  | 'RENAMED'

/**
 * 변경 한 줄 — `rel` 은 보이는 경로(이름 바뀜은 새 경로), `orig` 는 이름 바뀜·복사의 원래 경로(없으면 null).
 * `submodule` — porcelain v2 `<sub>` 칸이 `S` 로 시작(하위 모듈 항목, fix r1 R1-04). 있을 때만 붙는다.
 */
export type ScmChange = { group: ScmGroupId; status: ScmStatus; rel: string; orig: string | null; submodule?: true }

/** 그룹 순서·제목 (VS Code `repository.ts:1020-1023` — Merge Changes · Staged Changes · Changes). */
export const SCM_GROUPS: readonly { id: ScmGroupId; title: string }[] = [
  { id: 'merge', title: '병합 변경 사항' },
  { id: 'index', title: '스테이징된 변경 사항' },
  { id: 'workingTree', title: '변경 사항' },
  // LIFE-830 — base 대비 모드의 그룹 하나(작업 트리 모드 목록에는 이 그룹 변경이 없다).
  { id: 'base', title: 'base 대비 변경 사항' },
]

/** VS Code `git.statusLimit` 기본(`package.json:4017-4021`) — 넘으면 앞 것만 그리고 안내. */
export const SCM_STATUS_LIMIT = 10_000

const CONFLICT: Readonly<Record<string, ScmStatus>> = {
  DD: 'BOTH_DELETED',
  AU: 'ADDED_BY_US',
  UD: 'DELETED_BY_THEM',
  UA: 'ADDED_BY_THEM',
  DU: 'DELETED_BY_US',
  AA: 'BOTH_ADDED',
  UU: 'BOTH_MODIFIED',
}

const INDEX_SIDE: Readonly<Record<string, ScmStatus>> = { M: 'INDEX_MODIFIED', A: 'INDEX_ADDED', D: 'INDEX_DELETED', R: 'INDEX_RENAMED', C: 'INDEX_COPIED', T: 'INDEX_TYPE_CHANGED' }
const WORKING_SIDE: Readonly<Record<string, ScmStatus>> = { M: 'MODIFIED', D: 'DELETED', A: 'INTENT_TO_ADD', R: 'INTENT_TO_RENAME', T: 'TYPE_CHANGED' }

/**
 * porcelain v2 `-z` → 변경 목록(파일 순서는 git 출력 그대로 — 정렬은 보기가 한다). 필드 수는 v2 문서: `1` 8칸 뒤 경로 · `2` 9칸 뒤 경로 + NUL 원래 경로 ·
 * `u` 10칸 뒤 경로 · `?` 경로. ignored(`!`)는 보기에 없다(VS Code 도 `--ignored` 없이 부른다).
 * 이름 바뀜의 작업 트리 쪽(`RM`)은 VS Code `resourceUri` 처럼 새 경로로 보인다(`repository.ts:157-163`).
 */
export function parseScmChanges(stdout: string): ScmChange[] {
  const out: ScmChange[] = []
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record === undefined || record.length === 0 || record.startsWith('#')) continue
    const kind = record[0]
    if (kind === '?') {
      const rel = record.slice(2)
      // 끝이 `/` 인 추적 안 함 = 중첩 git 저장소 — VS Code `extensions/git/src/git.ts:895` 처럼 버린다(fix r1 R1-02).
      if (!rel.endsWith('/')) out.push({ group: 'workingTree', status: 'UNTRACKED', rel, orig: null })
      continue
    }
    if (kind === '!') continue
    const fields = record.split(' ')
    const xy = (fields[1] ?? '..').replace(/\./g, ' ')
    const sub: { submodule?: true } = (fields[2] ?? '').startsWith('S') ? { submodule: true } : {}
    if (kind === 'u') {
      const status = CONFLICT[xy]
      if (status !== undefined) out.push({ group: 'merge', status, rel: fields.slice(10).join(' '), orig: null })
      continue
    }
    let rel: string
    let orig: string | null = null
    if (kind === '1') rel = fields.slice(8).join(' ')
    else if (kind === '2') {
      rel = fields.slice(9).join(' ')
      i += 1
      orig = records[i] ?? null
    } else continue
    const conflict = CONFLICT[xy]
    if (conflict !== undefined) {
      out.push({ group: 'merge', status: conflict, rel, orig: null })
      continue
    }
    const x = INDEX_SIDE[xy[0] ?? ' ']
    if (x !== undefined) out.push({ group: 'index', status: x, rel, orig: x === 'INDEX_RENAMED' || x === 'INDEX_COPIED' ? orig : null, ...sub })
    const y = WORKING_SIDE[xy[1] ?? ' ']
    if (y !== undefined) out.push({ group: 'workingTree', status: y, rel, orig: y === 'INTENT_TO_RENAME' ? orig : null, ...sub })
  }
  return out
}

/** 상태 글자(`GIT_DECORATION` 키) — VS Code `getStatusLetter`(`repository.ts:62-95`). */
export function scmMark(status: ScmStatus): GitMark {
  switch (status) {
    case 'INDEX_MODIFIED':
    case 'MODIFIED':
      return 'M'
    case 'INDEX_ADDED':
    case 'INTENT_TO_ADD':
    case 'ADDED':
      return 'A'
    case 'INDEX_DELETED':
    case 'DELETED':
      return 'D'
    case 'INDEX_RENAMED':
    case 'INTENT_TO_RENAME':
    case 'RENAMED':
      return 'R'
    case 'INDEX_TYPE_CHANGED':
    case 'TYPE_CHANGED':
      return 'T'
    case 'UNTRACKED':
      return 'U'
    case 'INDEX_COPIED':
      return 'C'
    case 'BOTH_DELETED':
    case 'ADDED_BY_US':
    case 'DELETED_BY_THEM':
    case 'ADDED_BY_THEM':
    case 'DELETED_BY_US':
    case 'BOTH_ADDED':
    case 'BOTH_MODIFIED':
      return '!'
  }
}

/** 툴팁 상태 문구 — VS Code `getStatusText`(`repository.ts:97-120`)의 한국어. */
export const SCM_STATUS_TEXT: Readonly<Record<ScmStatus, string>> = {
  INDEX_MODIFIED: '인덱스 수정됨',
  MODIFIED: '수정됨',
  INDEX_ADDED: '인덱스 추가됨',
  INDEX_DELETED: '인덱스 삭제됨',
  DELETED: '삭제됨',
  INDEX_RENAMED: '인덱스 이름 바뀜',
  INDEX_COPIED: '인덱스 복사됨',
  INDEX_TYPE_CHANGED: '인덱스 형식 바뀜',
  UNTRACKED: '추적 안 함',
  INTENT_TO_ADD: '추가 예정',
  INTENT_TO_RENAME: '이름 바꾸기 예정',
  TYPE_CHANGED: '형식 바뀜',
  BOTH_DELETED: '충돌: 둘 다 삭제',
  ADDED_BY_US: '충돌: 우리가 추가',
  DELETED_BY_THEM: '충돌: 상대가 삭제',
  ADDED_BY_THEM: '충돌: 상대가 추가',
  DELETED_BY_US: '충돌: 우리가 삭제',
  BOTH_ADDED: '충돌: 둘 다 추가',
  BOTH_MODIFIED: '충돌: 둘 다 수정',
  ADDED: '추가됨',
  RENAMED: '이름 바뀜',
}

/** 취소선 — VS Code `strikeThrough`(`repository.ts:251-262`). */
export function scmStrike(status: ScmStatus): boolean {
  return status === 'DELETED' || status === 'INDEX_DELETED' || status === 'BOTH_DELETED' || status === 'DELETED_BY_THEM' || status === 'DELETED_BY_US'
}

// --- 정렬·트리 ------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 이름 비교 — 탐색기 `compareEntries` 와 같은 자연 정렬(VS Code `compareFileNames`), 같으면 코드 단위. */
export function compareNames(a: string, b: string): number {
  const byName = collator.compare(a, b)
  if (byName !== 0) return byName
  return a < b ? -1 : a > b ? 1 : 0
}

/** 경로 비교 — VS Code `comparers.ts:278-303` `comparePaths`: 앞 성분부터 비교하다 한쪽이 먼저 끝나면(그 깊이의 파일) 그쪽이 앞, 둘 다 끝나면 이름 비교. */
export function comparePaths(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  const last = Math.min(left.length, right.length) - 1
  for (let index = 0; index < last; index += 1) {
    const byPart = compareNames(left[index] ?? '', right[index] ?? '')
    if (byPart !== 0) return byPart
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return compareNames(left[last] ?? '', right[last] ?? '')
}

export type ScmGroupView = { id: ScmGroupId; title: string; changes: ScmChange[] }

/**
 * 그룹으로 묶는다 — 순서는 `SCM_GROUPS`, 그룹 안은 경로순(`scm.defaultViewSortKey: path`). 병합·스테이지는 비면 숨김(`repository.ts:1025-1028,1058-1059`),
 * 「변경」 도 비면 숨긴다 — 변경이 하나도 없으면 그룹 0 개(빈 상태 문구는 보기 몫, D1). `limit` 을 넘는 변경은 앞에서부터 잘라 `truncated` 로 알린다.
 */
export function groupChanges(changes: readonly ScmChange[], limit = SCM_STATUS_LIMIT, total = changes.length): { groups: ScmGroupView[]; total: number; truncated: boolean } {
  const shown = changes.slice(0, limit)
  const groups = SCM_GROUPS.map((group) => ({ ...group, changes: shown.filter((change) => change.group === group.id).sort((a, b) => comparePaths(a.rel, b.rel)) })).filter((group) => group.changes.length > 0)
  // `total` — main 이 상한 + 1 로 잘라 보낸 경우의 전체 개수(fix r1 R1-05). 안내는 그 값으로.
  return { groups, total, truncated: total > limit }
}

export type ScmTreeNode = { kind: 'dir'; name: string; path: string; children: ScmTreeNode[] } | { kind: 'file'; name: string; change: ScmChange }

/**
 * 트리 — 폴더 먼저, 이름순(`scmViewPane.ts:784-795`). 자식이 폴더 하나뿐인 폴더는 `a/b` 한 마디로 압축(`scm.compactFolders: true`).
 * 폴더 `path` 는 압축된 마지막 폴더까지의 경로(접기 키).
 */
export function buildTree(changes: readonly ScmChange[]): ScmTreeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: ScmChange[] }
  const root: Dir = { dirs: new Map(), files: [] }
  for (const change of changes) {
    const parts = change.rel.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        at.dirs.set(part, next)
      }
      at = next
    }
    at.files.push(change)
  }
  const nameOf = (change: ScmChange): string => change.rel.slice(change.rel.lastIndexOf('/') + 1)
  const toNodes = (dir: Dir, prefix: string): ScmTreeNode[] => {
    const dirs = [...dir.dirs].map(([name, child]): ScmTreeNode => {
      let label = name
      let node = child
      let path = prefix === '' ? name : `${prefix}/${name}`
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [nextName, nextNode] = [...node.dirs][0] ?? ['', node]
        label = `${label}/${nextName}`
        path = `${path}/${nextName}`
        node = nextNode
      }
      return { kind: 'dir', name: label, path, children: toNodes(node, path) }
    })
    const files = dir.files.map((change): ScmTreeNode => ({ kind: 'file', name: nameOf(change), change }))
    return [...dirs.sort((a, b) => compareNames(a.name, b.name)), ...files.sort((a, b) => compareNames(a.name, b.name))]
  }
  return toNodes(root, '')
}

/** 트리를 그릴 줄로 — 접힌 폴더(`collapsed` 의 path)의 자식은 뺀다. depth 는 그룹 아래 1 부터. */
export type ScmTreeRow = { kind: 'dir'; name: string; path: string; depth: number; collapsed: boolean } | { kind: 'file'; name: string; change: ScmChange; depth: number }
export function flattenTree(nodes: readonly ScmTreeNode[], collapsed: ReadonlySet<string>, depth = 1): ScmTreeRow[] {
  return nodes.flatMap((node): ScmTreeRow[] => {
    if (node.kind === 'file') return [{ kind: 'file', name: node.name, change: node.change, depth }]
    const isCollapsed = collapsed.has(node.path)
    return [{ kind: 'dir', name: node.name, path: node.path, depth, collapsed: isCollapsed }, ...(isCollapsed ? [] : flattenTree(node.children, collapsed, depth + 1))]
  })
}

// --- 클릭 대상 (S5) ---------------------------------------------------------------

/**
 * 읽을 쪽 — `working` 은 작업 파일(기존 파일 읽기 IPC), 나머지는 git 객체(`scmRead`).
 * `base` = base 대비의 merge-base 커밋(LIFE-830) — 렌더러는 이 고정 값만 보내고 base·merge-base 는 main 이 그 루트에서 푼다.
 */
export type ScmSide = 'head' | 'index' | 'working' | 'base'

/**
 * diff 탭의 모드 — 탭 id 에 실려 영속된다. 제목 꼬리는 VS Code `getTitle`.
 *   · `wt`       인덱스 ↔ 작업 파일, (작업 트리) — VS Code `~` 는 인덱스 그룹에 있으면 인덱스, 없으면 HEAD 인데(`fileSystemProvider.ts:21-27`)
 *                인덱스 그룹에 없으면 인덱스 = HEAD 라 인덱스로 읽는 것과 같다
 *   · `wtType`   HEAD ↔ 작업 파일, (형식 바뀜)
 *   · `wtRename` HEAD(원래) ↔ 작업 파일, (이름 바꾸기 예정)
 *   · `idx`      HEAD(원래 경로 또는 같은 경로) ↔ 인덱스, (인덱스)
 *   · `idxOnly`  인덱스 단일, (인덱스)
 *   · `deleted`  HEAD 단일, (삭제됨)
 *   · `base`        merge-base(원래 경로 또는 같은 경로) ↔ 작업 파일, (base 대비) — LIFE-830. 추가·추적 안 함도 이 모드(왼쪽이 없어 빈 왼쪽 diff)
 *   · `baseDeleted` merge-base 단일, (base 대비 · 삭제됨) — LIFE-830
 */
export type ScmDiffMode = 'wt' | 'wtType' | 'wtRename' | 'idx' | 'idxOnly' | 'deleted' | 'base' | 'baseDeleted'
export type ScmDiffTarget = { mode: ScmDiffMode; rel: string; orig: string | null }

export type ScmOpen = { kind: 'diff'; target: ScmDiffTarget } | { kind: 'file'; rel: string } | { kind: 'notice'; message: string }

/**
 * 행 클릭이 여는 것 — VS Code `resolveChangeCommand`. 충돌은 작업 파일(`git.mergeEditor` 기본 false).
 * 하위 모듈 항목은 내용 비교가 없다 — VS Code 는 `getResources` 의 submodule 분기(`repository.ts:581-586`)로 그 하위 저장소를 열지만
 * 여러 저장소 표시는 범위 밖이라 안내만 한다(fix r1 R1-04).
 */
export function openOf(change: ScmChange): ScmOpen {
  const { rel, orig } = change
  if (change.submodule === true) return { kind: 'notice', message: `${rel} 은(는) 하위 모듈입니다 — 소스 제어 보기는 하위 모듈의 내용 비교를 보여 주지 않습니다.` }
  if (change.group === 'base') return openOfBase(change)
  switch (change.status) {
    case 'MODIFIED':
      return { kind: 'diff', target: { mode: 'wt', rel, orig: null } }
    case 'TYPE_CHANGED':
      return { kind: 'diff', target: { mode: 'wtType', rel, orig: null } }
    case 'INTENT_TO_RENAME':
      return { kind: 'diff', target: { mode: 'wtRename', rel, orig } }
    case 'INDEX_MODIFIED':
    case 'INDEX_TYPE_CHANGED':
      return { kind: 'diff', target: { mode: 'idx', rel, orig: null } }
    case 'INDEX_RENAMED':
      return { kind: 'diff', target: { mode: 'idx', rel, orig } }
    case 'INDEX_ADDED':
    case 'INDEX_COPIED':
      return { kind: 'diff', target: { mode: 'idxOnly', rel, orig: null } }
    case 'INDEX_DELETED':
    case 'DELETED':
      return { kind: 'diff', target: { mode: 'deleted', rel, orig: null } }
    case 'UNTRACKED':
    case 'INTENT_TO_ADD':
    case 'BOTH_DELETED':
    case 'ADDED_BY_US':
    case 'DELETED_BY_THEM':
    case 'ADDED_BY_THEM':
    case 'DELETED_BY_US':
    case 'BOTH_ADDED':
    case 'BOTH_MODIFIED':
    case 'ADDED':
    case 'RENAMED':
      return { kind: 'file', rel }
  }
}

/**
 * base 대비 행 클릭(LIFE-830 B5) — 왼쪽은 merge-base 쪽, 오른쪽은 작업 파일. 이름 바뀜은 원래 경로 ↔ 새 경로.
 * 추가·추적 안 함은 같은 `base` 모드(merge-base 쪽에 없어 빈 왼쪽 diff), 삭제는 merge-base 단일, 충돌은 작업 파일(작업 트리 모드와 같다).
 */
function openOfBase(change: ScmChange): ScmOpen {
  const { rel } = change
  switch (change.status) {
    case 'DELETED':
      return { kind: 'diff', target: { mode: 'baseDeleted', rel, orig: null } }
    case 'RENAMED':
      return { kind: 'diff', target: { mode: 'base', rel, orig: change.orig } }
    case 'BOTH_MODIFIED':
      return { kind: 'file', rel }
    default:
      return { kind: 'diff', target: { mode: 'base', rel, orig: null } }
  }
}

/** 모드의 양쪽 — `left` 가 null 이면 단일 읽기 전용 보기. */
export function sidesOf(target: ScmDiffTarget): { left: { side: ScmSide; rel: string } | null; right: { side: ScmSide; rel: string } } {
  const { rel } = target
  const orig = target.orig ?? rel
  switch (target.mode) {
    case 'wt':
      return { left: { side: 'index', rel }, right: { side: 'working', rel } }
    case 'wtType':
      return { left: { side: 'head', rel }, right: { side: 'working', rel } }
    case 'wtRename':
      return { left: { side: 'head', rel: orig }, right: { side: 'working', rel } }
    case 'idx':
      return { left: { side: 'head', rel: orig }, right: { side: 'index', rel } }
    case 'idxOnly':
      return { left: null, right: { side: 'index', rel } }
    case 'deleted':
      return { left: null, right: { side: 'head', rel } }
    case 'base':
      return { left: { side: 'base', rel: orig }, right: { side: 'working', rel } }
    case 'baseDeleted':
      return { left: null, right: { side: 'base', rel } }
  }
}

const TITLE_SUFFIX: Readonly<Record<ScmDiffMode, string>> = {
  wt: '작업 트리',
  wtType: '형식 바뀜',
  wtRename: '이름 바꾸기 예정',
  idx: '인덱스',
  idxOnly: '인덱스',
  deleted: '삭제됨',
  base: 'base 대비',
  baseDeleted: 'base 대비 · 삭제됨',
}

/** 탭 제목 — VS Code `l10n.t('{0} (Index)', basename)` 형식. */
export function diffTitle(target: ScmDiffTarget): string {
  return `${target.rel.slice(target.rel.lastIndexOf('/') + 1)} (${TITLE_SUFFIX[target.mode]})`
}

// --- 탭 id (영속) -------------------------------------------------------------------

/**
 * diff 탭 id — `diff:` + JSON `[모드, 경로, 원래 경로|null]`. 배치(`groupLayouts`)에 문자열로 영속된다.
 * 기준 빌드(682)는 `file:` 이 아닌 이 id 를 herdr 에 없는 터미널 탭으로 보고 걷는다 — 터미널 배치는 남는다(S10).
 */
export const DIFF_TAB_PREFIX = 'diff:'
// LIFE-830 — base 두 모드는 뒤에 더했다. 옛 id 는 그대로 읽히고, 기준 빌드(v0.6.0)는 이 모드를 모르는 id 로 보아 `broken` diff 탭으로 그린다(B10).
const MODES: readonly ScmDiffMode[] = ['wt', 'wtType', 'wtRename', 'idx', 'idxOnly', 'deleted', 'base', 'baseDeleted']

export function diffTabId(target: ScmDiffTarget): string {
  return `${DIFF_TAB_PREFIX}${JSON.stringify([target.mode, target.rel, target.orig])}`
}

/** 경로 모양 — 루트 상대, 빈 성분·`.`·`..`·NUL·절대경로 없음. main 이 다시 본다. */
export function isPlainRel(rel: string): boolean {
  if (rel === '' || rel.includes('\0') || rel.startsWith('/')) return false
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function parseDiffTabId(tabId: string): ScmDiffTarget | null {
  if (!tabId.startsWith(DIFF_TAB_PREFIX)) return null
  let value: unknown
  try {
    value = JSON.parse(tabId.slice(DIFF_TAB_PREFIX.length))
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length !== 3) return null
  const [mode, rel, orig] = value
  const knownMode = MODES.find((item) => item === mode)
  if (knownMode === undefined || typeof rel !== 'string' || !isPlainRel(rel)) return null
  if (orig !== null && (typeof orig !== 'string' || !isPlainRel(orig))) return null
  return { mode: knownMode, rel, orig }
}

/** git 조회 오류 종류 (fix r1 R1-08) — 「저장소 아님」만 VS Code 문구, 나머지(타임아웃·출력 상한·git 없음)는 조회 실패. */
export function scmErrorKind(error: string): 'not_repo' | 'failed' {
  return /not a git repository/i.test(error) ? 'not_repo' : 'failed'
}

// --- 읽기 IPC (S7) -------------------------------------------------------------------

export type ScmReadInput = { root: string; rel: string; side: 'head' | 'index' | 'base' }
/** `base` — side `base` 로 읽었을 때 main 이 실제로 쓴 base(머리 표지용). 다른 side 에는 없다. */
export type ScmReadResult =
  | { ok: true; kind: 'text'; text: string; size: number; base?: ScmBaseInfo }
  | { ok: true; kind: 'binary'; size: number; base?: ScmBaseInfo }
  | { ok: true; kind: 'too_large'; size: number; limit: number; base?: ScmBaseInfo }
  | { ok: true; kind: 'missing'; base?: ScmBaseInfo }
  | { ok: false; code: 'not_worktree' | 'bad_path' | 'git_error'; error: string }

// --- base 대비 (LIFE-830) ---------------------------------------------------------------

/** base 를 어디서 얻었나 — 00-analysis 3.2 순서: 부모 worktree → repo 설정(`baseRef`) → 원격 기본 브랜치 사슬. */
export type ScmBaseSource = 'parent' | 'repo' | 'default'
export const SCM_BASE_SOURCE_TEXT: Readonly<Record<ScmBaseSource, string>> = { parent: '부모 worktree', repo: 'repo 설정', default: '원격 기본' }

/** main 이 푼 base — `name` 은 보이는 이름(브랜치·ref 이름, 분리된 HEAD 면 짧은 해시), `mergeBase` 는 merge-base 커밋 전체 해시. */
export type ScmBaseInfo = { name: string; source: ScmBaseSource; mergeBase: string }

/**
 * 허브가 base 대비 모드인 루트의 git push 에 싣는 것. `changes` 는 상한 + 1 개까지(작업 트리 목록과 같은 규칙), `total` 은 전체 개수.
 * 실패: `no_base` — 세 출처 다 커밋으로 안 풀림 · `no_merge_base` — 관련 없는 이력 · `git_error` — 그 밖.
 */
export type ScmBasePush = { ok: true; info: ScmBaseInfo; changes: ScmChange[]; total: number } | { ok: false; reason: 'no_base' | 'no_merge_base' | 'git_error'; error: string }

/** base 를 못 정했을 때 안내(B2ⓓ) — 정하는 방법 한 줄. */
export const SCM_NO_BASE_HELP = 'base 브랜치를 찾지 못했습니다 — `corral worktree set <worktree> --parent-worktree <부모>` 로 부모 worktree 를 지정하거나 `corral repo set-base-ref <repo> <ref>` 로 base 를 정하세요.'

const BASE_STATUS: Readonly<Record<string, ScmStatus>> = { A: 'ADDED', M: 'MODIFIED', D: 'DELETED', R: 'RENAMED', T: 'TYPE_CHANGED', U: 'BOTH_MODIFIED' }

/**
 * `git diff --raw -z -M <merge-base> --` → base 대비 변경(그룹 `base`). 레코드: `:<모드> <모드> <oid> <oid> <상태>` NUL 경로 [NUL 새 경로(R·C)].
 * 상태 글자 뒤 점수(`R100`)는 버린다. 어느 쪽 모드든 160000 이면 하위 모듈. 모르는 글자(C·X 등 — `-C` 없이 안 나온다)는 경로만 건너뛴다.
 */
export function parseBaseDiff(stdout: string): ScmChange[] {
  const out: ScmChange[] = []
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record === undefined || !record.startsWith(':')) continue
    const fields = record.slice(1).split(' ')
    const letter = (fields[4] ?? '')[0] ?? ''
    const sub: { submodule?: true } = fields[0] === '160000' || fields[1] === '160000' ? { submodule: true } : {}
    const first = records[i + 1] ?? ''
    i += 1
    if (letter === 'R' || letter === 'C') {
      const second = records[i + 1] ?? ''
      i += 1
      if (letter === 'R') out.push({ group: 'base', status: 'RENAMED', rel: second, orig: first, ...sub })
      continue
    }
    const status = BASE_STATUS[letter]
    if (status !== undefined && first !== '') out.push({ group: 'base', status, rel: first, orig: null, ...sub })
  }
  return out
}

/** base 대비 목록 = diff 결과 + 지금 status 의 추적 안 함(diff 는 추적 안 함을 안 준다 — 00-analysis C9). */
export function withUntracked(input: { diff: readonly ScmChange[]; status: readonly ScmChange[] }): ScmChange[] {
  return [...input.diff, ...input.status.filter((change) => change.status === 'UNTRACKED').map((change): ScmChange => ({ ...change, group: 'base' }))]
}
