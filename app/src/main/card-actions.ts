// 카드 메뉴 동작 (LIFE-478 · 448 S4-C) — 렌더러 IPC 와 런타임·셸 사이.
//
// **레지스트리 쓰기·삭제 로직은 여기 없다.** `worktree set`·`worktree rm` 을 CLI 와 **같은 디스패처**
// (`startRuntime().invoke` — 같은 검증·같은 `serialKey: 'workspace'` 줄·같은 잠금)로 돌릴 뿐이다(K1ⓑ·K7ⓒ).
// 여기서 하는 일은 ① 렌더러가 준 경로가 **등록된 레포·워크트리인지** 다시 보는 것(K4ⓔ) ② 화면 입력을 CLI 플래그로
// 옮기는 것 ③ 삭제 확인 대화가 보여 줄 사실(dirty 수·세션 수·잠김·자식)을 읽는 것뿐이다.
import fs from 'node:fs'
import path from 'node:path'
import type { Invocation, RpcResponse } from '../runtime/contracts.js'
import type { ProcessObservation } from '../runtime/workspace/model.js'
import { isLockedWorktree } from '../runtime/workspace/index.js'
import { git } from '../runtime/workspace/model.js'
import type { CardActionError, ShellActionResult, WorktreeDeletePreview, WorktreeDeleteResult, WorktreeMetaResult, WorktreeMetaUpdate } from '../shared/types.js'
import { isRecord } from '../shared/json.js'

export type CardActionDeps = {
  /** 런타임 디스패처 — 없으면(런타임 기동 전) 거절. */
  invoke: () => ((invocation: Invocation) => Promise<RpcResponse>) | null
  /**
   * LIFE-603 F3 — 「작업에서 시작」 이 진행 중인가. 시작은 런타임 workspace 줄을 에이전트 ready 까지 잡는다 — 그 뒤에 서면 이 IPC 의
   * 60초 기한이 먼저 끝나 거짓 오류(`request_cancelled`)가 난다. 그래서 진행 중이면 보내지 않고 이유를 바로 돌려준다. 없으면 늘 false.
   */
  startBusy?: () => boolean
  /** 지금 화면 트리의 워크트리 — `{ repoRoot, path, branch, isLinked }`. 여기 없는 경로는 받지 않는다. */
  worktrees: () => Array<{ repoRoot: string; path: string; branch: string | null; isLinked: boolean }>
  repoRoots: () => readonly string[]
  /** 레지스트리 메타의 경로 → 부모 경로. */
  parentPaths: () => ReadonlyMap<string, string | null>
  /** `worktree rm` 이 바쁨 판정에 쓰는 것과 같은 관측(herdr 링크 필수 — 없으면 던진다). */
  observe: () => Promise<ProcessObservation[]>
  showItemInFolder: (target: string) => void
  writeClipboard: (text: string) => void
  /** 편집기 실행 — 실패면 오류 문자열. */
  launchEditor: (target: string) => Promise<string | null>
  cwd: string
}

const refused = (error: string): CardActionError => ({ ok: false, code: 'invalid_argument', error })

/** 렌더러 경로 검사 (K4ⓔ) — 절대경로 · 지금 트리에 있는 워크트리 · 디스크에 있다. */
function knownWorktree(deps: CardActionDeps, target: unknown) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null
  const row = deps.worktrees().find((item) => item.path === target)
  if (row === undefined || !fs.existsSync(target)) return null
  return row
}

function knownRepo(deps: CardActionDeps, target: unknown): string | null {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null
  return deps.repoRoots().includes(target) && fs.existsSync(target) ? target : null
}

async function run(deps: CardActionDeps, invocation: Omit<Invocation, 'args' | 'cwd'>): Promise<{ ok: true; result: unknown } | { ok: false; code: string; error: string }> {
  if (deps.startBusy?.() === true) return { ok: false, code: 'start_in_progress', error: '작업 시작이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' }
  const invoke = deps.invoke()
  if (invoke === null) return { ok: false, code: 'runtime_unavailable', error: '런타임이 아직 안 섰다' }
  const response = await invoke({ ...invocation, args: [], cwd: deps.cwd })
  if (response.ok) return { ok: true, result: response.result }
  return { ok: false, code: response.error?.code ?? 'operation_failed', error: response.error?.message ?? '알 수 없는 오류' }
}

/** 표시 이름·comment·부모 — CLI `worktree set --display-name/--comment/--parent-worktree/--no-parent` 그대로. */
export async function setWorktreeMeta(deps: CardActionDeps, input: WorktreeMetaUpdate): Promise<WorktreeMetaResult> {
  const row = knownWorktree(deps, input?.path)
  if (row === null) return refused('등록된 워크트리가 아니다')
  const flags: Invocation['flags'] = { worktree: `path:${row.path}` }
  // CLI 의 지움 표기는 문자열 'null' 이다(`updateMetadata`). 빈 값도 지움 — 198 「빈 값 = 브랜치로 되돌림」.
  const text = (value: string | null) => (value === null || value.trim() === '' ? 'null' : value.trim())
  if (input.displayName !== undefined) flags['display-name'] = text(input.displayName)
  if (input.comment !== undefined) flags.comment = text(input.comment)
  if (input.parentPath === null) flags['no-parent'] = true
  else if (input.parentPath !== undefined) {
    const parent = knownWorktree(deps, input.parentPath)
    if (parent === null) return refused('상위 워크트리가 등록된 워크트리가 아니다')
    flags['parent-worktree'] = `path:${parent.path}`
  }
  if (Object.keys(flags).length === 1) return refused('바꿀 칸이 없다')
  const outcome = await run(deps, { command: 'worktree set', flags })
  return outcome.ok ? { ok: true } : outcome
}

/** 삭제 확인 대화가 여는 순간 읽는 사실. 판정·실행은 하지 않는다. */
export async function previewWorktreeDelete(deps: CardActionDeps, input: { path: string }): Promise<WorktreeDeletePreview> {
  const row = knownWorktree(deps, input?.path)
  if (row === null) return refused('등록된 워크트리가 아니다')
  try {
    const status = await git(row.path, ['status', '--porcelain', '--untracked-files=all'])
    const dirtyCount = status === '' ? 0 : status.split('\n').length
    const locked = await isLockedWorktree(row.repoRoot, row.path)
    let liveSessions: number | null = null
    let backendError: string | null = null
    try {
      liveSessions = (await deps.observe()).find((item) => item.path === row.path)?.liveTerminalCount ?? 0
    } catch (error) {
      backendError = error instanceof Error ? error.message : String(error)
    }
    const childPaths = [...deps.parentPaths()].filter(([, parent]) => parent === row.path).map(([child]) => child)
    return { ok: true, path: row.path, branch: row.branch, isMain: !row.isLinked, locked, dirtyCount, liveSessions, backendError, childPaths }
  } catch (error) {
    return { ok: false, code: 'preview_failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** CLI `worktree rm [--force]` 그대로 — 보호·dirty·바쁨·잠김·세션 닫기·git·브랜치·메타 순서는 런타임이 정한다. */
export async function deleteWorktree(deps: CardActionDeps, input: { path: string; force: boolean }): Promise<WorktreeDeleteResult> {
  const row = knownWorktree(deps, input?.path)
  if (row === null) return refused('등록된 워크트리가 아니다')
  const outcome = await run(deps, { command: 'worktree rm', flags: { worktree: `path:${row.path}`, ...(input.force === true ? { force: true } : {}) } })
  if (!outcome.ok) return outcome
  const result = isRecord(outcome.result) ? outcome.result : {}
  const preserved = isRecord(result.preservedBranch) && typeof result.preservedBranch.branchName === 'string' ? result.preservedBranch.branchName : null
  return { ok: true, preservedBranch: preserved, warning: typeof result.warning === 'string' ? result.warning : null }
}

export function revealInFinder(deps: CardActionDeps, input: { path: string; kind: 'worktree' | 'repo' }): ShellActionResult {
  const target = input?.kind === 'repo' ? knownRepo(deps, input.path) : knownWorktree(deps, input?.path)?.path ?? null
  if (target === null) return refused(input?.kind === 'repo' ? '등록된 레포가 아니다' : '등록된 워크트리가 아니다')
  deps.showItemInFolder(target)
  return { ok: true }
}

export function copyPath(deps: CardActionDeps, input: { path: string }): ShellActionResult {
  const row = knownWorktree(deps, input?.path)
  if (row === null) return refused('등록된 워크트리가 아니다')
  deps.writeClipboard(row.path)
  return { ok: true }
}

export async function openInEditor(deps: CardActionDeps, input: { path: string }): Promise<ShellActionResult> {
  const row = knownWorktree(deps, input?.path)
  if (row === null) return refused('등록된 워크트리가 아니다')
  const error = await deps.launchEditor(row.path)
  return error === null ? { ok: true } : { ok: false, code: 'editor_failed', error }
}
