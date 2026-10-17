// 탐색기 git 상태 (LIFE-589 E5) — `git status --porcelain=v2 -z --untracked-files=all --ignored=matching` 한 번으로 상태 색·배지와 ignored 흐림을 같이 만든다
// (기준선 `raw/claude/e3-baseline/ignored-cost.txt` — ignored 를 더해도 status 와 같은 비용 약 200 ms).
//
// 글자·색은 VS Code git 확장(`extensions/git/src/repository.ts` getStatusLetter·getStatusColor, 1.142)과 같고, 색 값은 Dark 2026
// (`theme-defaults/themes/2026-dark.json` gitDecoration.*, renamed 는 테마에 없어 git 확장 기본 dark `#73C991`).
// 한 파일이 인덱스·작업 트리 둘 다 바뀌었으면 **작업 트리 쪽**을 보인다(디스크의 지금 모습 — VS Code 는 두 리소스를 따로 들고 첫 것을 칠한다).
// 디스크에 없는 삭제 파일은 트리에 행이 없다(VS Code 와 같다) — 그리고 폴더로 전파하지 않는다(VS Code `propagate = !DELETED`).

export type GitMark = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!' | 'I'

export type GitDecoration = { letter: string; color: string; title: string }

export const GIT_DECORATION: Record<GitMark, GitDecoration> = {
  M: { letter: 'M', color: '#e5ba7d', title: '수정됨' },
  T: { letter: 'T', color: '#e5ba7d', title: '형식 바뀜' },
  A: { letter: 'A', color: '#73c991', title: '추가됨(인덱스)' },
  D: { letter: 'D', color: '#f48771', title: '삭제됨' },
  R: { letter: 'R', color: '#73c991', title: '이름 바뀜' },
  C: { letter: 'C', color: '#73c991', title: '복사됨' },
  U: { letter: 'U', color: '#73c991', title: '추적 안 함' },
  '!': { letter: '!', color: '#f48771', title: '충돌' },
  I: { letter: '', color: '#8c8c8c', title: 'Git 제외' },
}

/**
 * 폴더 색 우선순위 (E5ⓑ) — 하위에 여럿이면 가장 높은 것. 충돌 > 수정 > 이름 바뀜·복사 > 추가 > 추적 안 함. 삭제·ignored 는 전파하지 않는다.
 * VS Code 는 같은 무게의 하위 데코 중 첫 것을 쓴다(`decorationsService.ts` asDecoration — weight 정렬) — 순서가 경로 순회에 달려 흔들리므로
 * corral 은 Orca(`status-display.ts:23-45`)처럼 우선순위로 정한다(의도적 차이, E9 에 기록).
 */
export const FOLDER_PRIORITY: Partial<Record<GitMark, number>> = { '!': 5, M: 4, T: 4, R: 3, C: 3, A: 2, U: 1 }

export type GitSnapshot = {
  /** 루트 기준 상대 경로(`/`) → 상태. 이름 바뀜은 새 경로에 R. */
  marks: Map<string, GitMark>
  /** ignored — 폴더는 끝 `/` 를 뗀 경로. 그 밑은 전부 ignored. */
  ignored: Set<string>
}

const markOf = (xy: string): GitMark | null => {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  const side = y !== '.' ? y : x
  switch (side) {
    case 'M':
      return 'M'
    case 'T':
      return 'T'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C':
      return 'C'
    default:
      return null
  }
}

/** porcelain v2 `-z` 출력 → 스냅샷. 필드 수는 v2 문서 그대로(1: 8칸 뒤 경로, 2: 9칸 뒤 경로 + NUL 원래 경로, u: 10칸 뒤 경로). */
export function parsePorcelainV2(stdout: string): GitSnapshot {
  const marks = new Map<string, GitMark>()
  const ignored = new Set<string>()
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record === undefined || record.length === 0 || record.startsWith('#')) continue
    const kind = record[0]
    if (kind === '?' || kind === '!') {
      const target = record.slice(2)
      if (kind === '?') marks.set(target.replace(/\/$/, ''), 'U')
      else ignored.add(target.replace(/\/$/, ''))
      continue
    }
    const fields = record.split(' ')
    const xy = fields[1] ?? '..'
    if (kind === '1') {
      const target = fields.slice(8).join(' ')
      const mark = markOf(xy)
      if (mark !== null) marks.set(target, mark)
    } else if (kind === '2') {
      const target = fields.slice(9).join(' ')
      i += 1 // 다음 NUL 칸은 원래 경로
      const mark = markOf(xy)
      if (mark !== null) marks.set(target, mark)
    } else if (kind === 'u') {
      marks.set(fields.slice(10).join(' '), '!')
    }
  }
  return { marks, ignored }
}

/** 경로 또는 그 조상이 ignored 인가. */
export function isIgnoredPath(ignored: ReadonlySet<string>, rel: string): boolean {
  if (ignored.size === 0 || rel === '') return false
  for (let at = rel; at !== ''; at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '') if (ignored.has(at)) return true
  return false
}

/** 폴더별 전파 색 — 상태가 있는 파일마다 조상 폴더에 우선순위 최댓값을 올린다. */
export function folderMarks(marks: ReadonlyMap<string, GitMark>): Map<string, GitMark> {
  const out = new Map<string, GitMark>()
  for (const [rel, mark] of marks) {
    const priority = FOLDER_PRIORITY[mark]
    if (priority === undefined) continue
    let at = rel
    while (at.includes('/')) {
      at = at.slice(0, at.lastIndexOf('/'))
      const current = out.get(at)
      if (current !== undefined && (FOLDER_PRIORITY[current] ?? 0) >= priority) continue
      out.set(at, mark)
    }
  }
  return out
}

/** 줄로 실어 나르는 모양(IPC) — Map/Set 은 structured clone 되지만 로그·시험에서 읽기 쉽게 배열로. */
export type GitSnapshotWire = { marks: [string, GitMark][]; ignored: string[] }
export const toWire = (snapshot: GitSnapshot): GitSnapshotWire => ({ marks: [...snapshot.marks], ignored: [...snapshot.ignored] })
export const fromWire = (wire: GitSnapshotWire): GitSnapshot => ({ marks: new Map(wire.marks), ignored: new Set(wire.ignored) })
