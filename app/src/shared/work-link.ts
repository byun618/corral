// 작업 링크 모델 (LIFE-603 · 묶음 K11) — worktree 하나가 어느 출처의 어느 작업에 붙어 있나.
//
// - **명시 링크**: 「작업에서 시작」 으로 만든 worktree 에 main 이 적는다(`repos.json` `worktrees[path].workLink`). 출처 종류 · 연결 id · 작업 id · 키.
// - **자동 연결**: 명시 링크가 없는 worktree 의 브랜치 이름에서 출처 `keyPattern`(E3)으로 키를 찾는다 — **대소문자 그대로**(소문자 키는 붙지 않는다).
// - **예외**: 사이드바 「작업 떼기」 로 자동 연결을 끊은 worktree(`workLinkSuppressed`) — 다시 붙지 않는다.
// - 고르는 순서 = 명시 > 레포 기본 스페이스의 연결 > 유일 일치. 그래도 둘 이상이면 **붙이지 않는다**(추측 금지).
// - 한 브랜치에 키가 둘 이상이면(`LIFE-603-fix-LIFE-12`) 연결마다 **가장 왼쪽 키** 하나만 후보다 — 브랜치 이름은 「키-슬러그」 로 시작한다는 시작 규칙과 같은 방향.
// - 화면은 이 결과(`WorktreeWorkLink`)만 읽는다 — 사이드바 작업 줄 · 작업 중 보기 · 칩 · 상세 「실행」 이 같은 값을 본다. 판정은 main 이 이 함수로 한 번 한다.
//
// 이 파일은 Node·DOM 에 기대지 않는다(main · 렌더러 시험이 같이 쓴다). 출처 이름으로 분기하지 않는다.

import { isRecord } from './json.js'

/** `repos.json` 에 적는 명시 링크(영속 형식 — 설계 메모 `raw/claude/design-notes.md` §1). */
export type StoredWorkLink = { sourceId: string; connectionId: string; itemId: string; key: string; linkedAt: number }

/** 화면에 올리는 해석 결과. `connected` = 그 연결이 아직 있다(해제됐으면 키만 그린다). */
export type WorktreeWorkLink = {
  mode: 'explicit' | 'auto'
  sourceId: string
  connectionId: string
  key: string
  /** 명시 링크면 작업 id, 자동이면 null(키로 찾는다). */
  itemId: string | null
  connected: boolean
}

export type LinkConnection = { id: string; sourceId: string; keyPattern: string | null }

const MAX_FIELD = 512

const field = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD

/** 영속 값 손검증 — 모르는 모양은 null(호출자가 버리고 로그). */
export function readStoredWorkLink(value: unknown): StoredWorkLink | null {
  if (!isRecord(value)) return null
  const { sourceId, connectionId, itemId, key, linkedAt } = value
  if (!field(sourceId) || !field(connectionId) || !field(itemId) || !field(key)) return null
  if (typeof linkedAt !== 'number' || !Number.isFinite(linkedAt)) return null
  return { sourceId, connectionId, itemId, key, linkedAt }
}

/** 브랜치 안의 키 찾기 — 대소문자 그대로, 앞은 영숫자가 아니고 뒤는 숫자가 아닌 자리. 잘못된 패턴은 null. */
export function keyFinder(pattern: string | null): RegExp | null {
  if (pattern === null || pattern.length === 0) return null
  try {
    return new RegExp(`(?<![A-Za-z0-9])(${pattern})(?![0-9])`)
  } catch {
    return null
  }
}

/** 가장 왼쪽 키 하나 — `refs/heads/` 접두는 떼고 본다. */
export function branchLinkKey({ branch, pattern }: { branch: string; pattern: string | null }): string | null {
  const finder = keyFinder(pattern)
  if (finder === null) return null
  const name = branch.replace(/^refs\/heads\//, '')
  return finder.exec(name)?.[1] ?? null
}

/** worktree 하나의 링크 해석 — 명시 > 예외 > (레포 기본 연결 > 유일 일치), 모호하면 null. */
export function resolveWorkLink({ branch, explicit, suppressed, defaultConnectionId, connections }: {
  branch: string | null
  explicit: StoredWorkLink | null
  suppressed: boolean
  /** 이 worktree 레포의 기본 스페이스가 속한 연결 — 없으면 null. */
  defaultConnectionId: string | null
  connections: LinkConnection[]
}): WorktreeWorkLink | null {
  if (explicit !== null) {
    return { mode: 'explicit', sourceId: explicit.sourceId, connectionId: explicit.connectionId, key: explicit.key, itemId: explicit.itemId, connected: connections.some((row) => row.id === explicit.connectionId) }
  }
  if (suppressed || branch === null) return null
  const candidates = connections.flatMap((connection) => {
    const key = branchLinkKey({ branch, pattern: connection.keyPattern })
    return key === null ? [] : [{ connection, key }]
  })
  const preferred = candidates.find((candidate) => candidate.connection.id === defaultConnectionId)
  const chosen = preferred ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (chosen === undefined) return null
  return { mode: 'auto', sourceId: chosen.connection.sourceId, connectionId: chosen.connection.id, key: chosen.key, itemId: null, connected: true }
}

/** 같은 작업인가 — 명시 링크는 작업 id 로, 자동 링크는 키로(같은 연결 안에서). */
export function linkTargets({ link, connectionId, itemId, key }: { link: WorktreeWorkLink; connectionId: string; itemId: string; key: string }): boolean {
  if (link.connectionId !== connectionId) return false
  return link.itemId !== null ? link.itemId === itemId : link.key === key
}
