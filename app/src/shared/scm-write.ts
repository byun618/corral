// 소스 제어 로컬 쓰기 (LIFE-829) — 렌더러·main 이 같이 쓰는 요청·결과 형과 순수 함수.
//
// · 요청은 「동작 이름 + 루트(누른 때) + 경로」 뿐이다 — git 인자는 main 이 동작마다 고정 문자열로 만든다(`main/scm-write.ts`).
// · 행·그룹 단추가 보내는 경로는 여기 함수(`stageRequest`·`discardRequest`)가 변경 목록에서 만든다 — 이름 바뀜 unstage 는 원래 경로도 넘긴다(D4).
// · K2(LIFE-831 push·pull·fetch)는 `ScmWriteInput` 에 동작을 더한다.
import { isPlainRel, type ScmChange, type ScmGroupId } from './scm.js'

export type ScmWriteInput =
  | { action: 'stage'; root: string; paths: string[] }
  /** 병합 변경 stage — 늘 확인(D4). git 인자는 stage 와 같다. */
  | { action: 'stageMerge'; root: string; paths: string[] }
  | { action: 'unstage'; root: string; paths: string[] }
  /** 추적 파일 = 인덱스 내용으로 되돌림(`checkout --`), 추적 안 함 = 휴지통(D2·D3). 확인은 main 이 띄운다. */
  | { action: 'discard'; root: string; tracked: string[]; untracked: string[] }
  /** 빈 메시지 + amend = 직전 메시지 유지(`--no-edit` — D7·D8). */
  | { action: 'commit'; root: string; message: string; amend: boolean }

export type ScmWriteAction = ScmWriteInput['action']

export type ScmWriteRefusal =
  /** 확인 대화상자 취소 — git·파일 무변화. */
  | 'cancelled'
  | 'not_worktree'
  | 'bad_request'
  | 'empty_message'
  | 'nothing_to_commit'
  /** git 이 실패했다 — `error` 는 stderr 원문(훅 출력 포함). */
  | 'git_error'
  /** 휴지통으로 못 옮겼다 — 영구 삭제로 넘어가지 않는다. 파일은 그대로. */
  | 'trash_failed'

export type ScmWriteResult = { ok: true } | { ok: false; code: ScmWriteRefusal; error: string }

/** 요청 하나에 실리는 경로 상한 — 목록 상한(`SCM_STATUS_LIMIT` 10 000)의 이름 바뀜 두 경로까지. */
export const SCM_WRITE_MAX_PATHS = 20_000
const MAX_REL = 4096
const MAX_MESSAGE = 64 * 1024

const paths = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= SCM_WRITE_MAX_PATHS && value.every((item) => typeof item === 'string' && item.length <= MAX_REL && isPlainRel(item)) ? value.filter((item) => typeof item === 'string') : null

/** 렌더러가 보낸 요청의 형 검사 — 모르는 동작·경로 형 위반이면 null(git 실행 없이 거절 — K11). 루트가 열린 worktree 인지는 main 이 따로 본다. */
export function parseScmWriteInput(input: unknown): ScmWriteInput | null {
  if (typeof input !== 'object' || input === null) return null
  const field = (name: string): unknown => (name in input ? Reflect.get(input, name) : undefined)
  const root = field('root')
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) return null
  const action = field('action')
  if (action === 'stage' || action === 'stageMerge' || action === 'unstage') {
    const list = paths(field('paths'))
    return list === null || list.length === 0 ? null : { action, root, paths: list }
  }
  switch (action) {
    case 'discard': {
      const tracked = paths(field('tracked'))
      const untracked = paths(field('untracked'))
      if (tracked === null || untracked === null || tracked.length + untracked.length === 0 || tracked.length + untracked.length > SCM_WRITE_MAX_PATHS) return null
      return { action: 'discard', root, tracked, untracked }
    }
    case 'commit': {
      const message = field('message')
      const amend = field('amend')
      if (typeof message !== 'string' || message.length > MAX_MESSAGE || message.includes('\0') || typeof amend !== 'boolean') return null
      return { action: 'commit', root, message, amend }
    }
    default:
      return null
  }
}

/** 행·그룹 stage/unstage 단추 — 그룹이 동작을 정한다(V1·V2): 변경 = stage, 스테이지 = unstage(이름 바뀜은 원래 경로도), 병합 = stage(확인). */
export function stageRequest(input: { root: string; group: ScmGroupId; changes: readonly ScmChange[] }): ScmWriteInput {
  const rels = [...new Set(input.changes.map((change) => change.rel))]
  switch (input.group) {
    case 'workingTree':
      return { action: 'stage', root: input.root, paths: rels }
    case 'merge':
      return { action: 'stageMerge', root: input.root, paths: rels }
    case 'index':
      return {
        action: 'unstage',
        root: input.root,
        paths: [...new Set(input.changes.flatMap((change) => (change.status === 'INDEX_RENAMED' && change.orig !== null ? [change.rel, change.orig] : [change.rel])))],
      }
  }
}

/** discard 단추(「변경 사항」 그룹만 — V3) — 추적 안 함과 추적 파일을 나눈다. */
export function discardRequest(input: { root: string; changes: readonly ScmChange[] }): ScmWriteInput {
  const changes = input.changes.filter((change) => change.group === 'workingTree')
  return {
    action: 'discard',
    root: input.root,
    tracked: [...new Set(changes.filter((change) => change.status !== 'UNTRACKED').map((change) => change.rel))],
    untracked: [...new Set(changes.filter((change) => change.status === 'UNTRACKED').map((change) => change.rel))],
  }
}

/** 결과를 보기 안 안내 문구로 — git 오류는 stderr 원문 그대로(D10). 성공·취소는 null. */
export function scmWriteMessage(result: ScmWriteResult): { kind: 'info' | 'error'; text: string } | null {
  if (result.ok) return null
  switch (result.code) {
    case 'cancelled':
      return null
    case 'empty_message':
      return { kind: 'info', text: '커밋 메시지를 입력하세요.' }
    case 'nothing_to_commit':
      return { kind: 'info', text: '커밋할 변경 사항이 없습니다.' }
    case 'not_worktree':
      return { kind: 'error', text: `열린 worktree 가 아니어서 쓰지 않았습니다.\n${result.error}` }
    case 'bad_request':
      return { kind: 'error', text: `요청 형식이 올바르지 않습니다.\n${result.error}` }
    case 'trash_failed':
      return { kind: 'error', text: `휴지통으로 옮기지 못했습니다 — 파일은 그대로입니다.\n${result.error}` }
    case 'git_error':
      return { kind: 'error', text: result.error }
  }
}
