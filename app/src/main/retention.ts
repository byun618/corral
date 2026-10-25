// 「닫힌 탭」 보존 행의 main 쪽 판정 (LIFE-694).
//
// store 는 herdr 이벤트만 알고 카드를 모른다. 그래서 두 판정을 여기서 하고 store 에 넘긴다:
//   ① 사라지는 순간 — 카드 밖·주인 없음 workspace 의 pane 은 보존하지 않는다(`keepRetention` → store 정책).
//      corral 밖(herdr CLI 등)에서 닫혀도 붙을 카드가 없으니 보여 줄 자리가 없다. 카드에 붙은 workspace 의 외부 닫기는
//      지금처럼 보존한다(198 규칙 ②는 corral 이 명시적으로 닫은 것만 억제).
//   ② 공급할 때 — 보존 뒤 그 행의 worktree 가 지워져 cwd 가 죽은 worktree 자리가 되면 걷는다(`prunableRetained` — Orca
//      `pruneRetainedAgents` 대응). 안 걷으면 20칸을 차지해 정당한 행을 밀어내고, 같은 경로에 새 worktree 를 만들면 되살아 붙는다.
// 판정 불가(`cardlessGate` 가 null — 링크 재접속·골격 미준비·레포 읽기 실패·남의 세션)면 둘 다 지금처럼 보존한다.
// 잃는 쪽(정당한 완료 행 소실)보다 남는 쪽이 되돌리기 쉽다 — 남은 행은 ✕ 로 걷을 수 있다(LIFE-696).

import fs from 'node:fs'
import type { RetainedAgentRow, WorkspaceRow } from '../shared/types.js'
import { isDeadWorktreeSlot } from '../shared/worktree-slot.js'

/**
 * 사라지는 workspace 의 pane 을 보존해도 되나. false 는 셋이 다 맞을 때만이다:
 *   판정 가능(`cardless` 가 null 이 아님) · 그 workspace 가 카드 밖 · cwd 가 하나 이상이고 모두 주인 없는 쪽
 *   (HOME · 디렉터리 없음(`isDirectory` false 만 — 확인 불가 null 은 있음 쪽) · 죽은 worktree 자리).
 * cwd 가 하나도 없으면 판정 근거가 없어 보존한다(Resource 「경로 모름」 과 같은 자리).
 */
export function keepRetention(input: {
  workspaceId: string
  cwds: readonly string[]
  cardless: readonly WorkspaceRow[] | null
  homes: readonly string[]
  worktreePaths: readonly string[]
  isDirectory: (path: string) => boolean | null
}): boolean {
  if (input.cardless === null) return true
  if (!input.cardless.some((workspace) => workspace.workspaceId === input.workspaceId)) return true
  if (input.cwds.length === 0) return true
  const ownerless = (cwd: string): boolean =>
    input.homes.includes(cwd) || input.isDirectory(cwd) === false || isDeadWorktreeSlot({ path: cwd, worktreePaths: input.worktreePaths })
  return !input.cwds.every(ownerless)
}

/** 붙을 카드가 없어진 보존 행 — cwd 가 죽은 worktree 자리인 행의 paneId. 판정 불가면 하나도 걷지 않는다. */
export function prunableRetained(input: { retained: readonly RetainedAgentRow[]; determinable: boolean; worktreePaths: readonly string[] }): string[] {
  if (!input.determinable) return []
  return input.retained.flatMap((row) => (row.cwd !== null && isDeadWorktreeSlot({ path: row.cwd, worktreePaths: input.worktreePaths }) ? [row.paneId] : []))
}

/**
 * 경로가 지금 디렉터리인가 — 사라지는 순간 한 번만 묻는 동기 확인(닫힘은 드물다). `checkPath`(resource-ipc)와 같은 뜻:
 * `ENOENT`·`ENOTDIR`·파일이면 false, 그 밖의 stat 오류는 확인 불가(null — 있음 쪽).
 */
export function directoryNow(target: string): boolean | null {
  try {
    return fs.statSync(target).isDirectory()
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null
  }
}
