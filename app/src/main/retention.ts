// 「닫힌 탭」 보존 행의 main 쪽 판정 (LIFE-694).
//
// store 는 herdr 이벤트만 알고 카드를 모른다. 그래서 두 판정을 여기서 하고 store 에 넘긴다:
//   ① 사라지는 순간 — 카드 밖 workspace 의 pane 이 **그 자신의 cwd** 가 주인 없음(HOME·디렉터리 없음·확인된 죽은 자리)이면
//      보존하지 않는다(`keepRetention` → store 정책). corral 밖(herdr CLI 등)에서 닫혀도 붙을 카드가 없으니 보여 줄 자리가 없다.
//      pane 단위라 닫기 모양(workspace 한 건 / pane·탭 따로)과 무관하게 같은 답이 나온다(r1 리뷰 F2). 카드에 붙은 workspace 의
//      외부 닫기는 지금처럼 보존한다(198 규칙 ②는 corral 이 명시적으로 닫은 것만 억제).
//   ② 공급할 때 — 보존 뒤 그 행의 worktree 가 지워져 cwd 가 죽은 worktree 자리가 되면 걷는다(`prunableRetained` — Orca
//      `pruneRetainedAgents` 대응). 안 걷으면 20칸을 차지해 정당한 행을 밀어내고, 같은 경로에 새 worktree 를 만들면 되살아 붙는다.
// **죽은 자리는 목록 판정 + 파일시스템 확인 둘 다** 맞아야 센다(r1 리뷰 F1) — 걷기는 되돌릴 수 없는데, 목록 문자열만으로는
// 접근 거부로 목록에서 빠진 worktree·심링크 자리·골격이 아직 모르는 새 worktree 가 죽은 자리로 보인다. 자리 뿌리가 없거나,
// 있는데 그 안에 `.git` 항목이 없을 때만 죽은 자리다. 확인 불가(EACCES 등)는 죽은 자리가 아니다.
// 판정 불가(`cardlessGate` 가 null — 링크 재접속·골격 미준비·레포 읽기 실패·남의 세션)면 둘 다 지금처럼 보존한다.
// 그 창에 보존된 행 중 cwd 가 HOME·사라진 일반 경로인 것은 어느 카드에도 안 붙어 화면에 안 그려지고(✕ 로도 못 걷는다)
// 재시작·재연결이나 20칸 밀림으로만 빠진다 — 걷기를 「어디에도 안 붙는 행」 으로 넓히는 것은 범위 밖이다(r1 리뷰 F3).

import fs from 'node:fs'
import path from 'node:path'
import type { RetainedAgentRow, WorkspaceRow } from '../shared/types.js'
import { deadSlotRoot } from '../shared/worktree-slot.js'

/** 자리 뿌리의 파일시스템 상태 — `dead` 만 죽은 자리로 센다. */
export type SlotState = 'dead' | 'alive' | 'unknown'

const codeOf = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)
const gone = (error: unknown): boolean => codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'

/** 뿌리가 없음(ENOENT·ENOTDIR) → dead · 있는데 `.git` 이 없음 → dead · `.git` 있음 → alive · 그 밖의 오류 → unknown. */
export function slotStateNow(root: string): SlotState {
  try {
    fs.statSync(root)
  } catch (error) {
    return gone(error) ? 'dead' : 'unknown'
  }
  try {
    fs.lstatSync(path.join(root, '.git'))
    return 'alive'
  } catch (error) {
    return gone(error) ? 'dead' : 'unknown'
  }
}

/** `slotStateNow` 의 비동기판 — Resource 경로 캐시(697)가 쓴다. */
export async function slotStateOf(root: string): Promise<SlotState> {
  try {
    await fs.promises.stat(root)
  } catch (error) {
    return gone(error) ? 'dead' : 'unknown'
  }
  try {
    await fs.promises.lstat(path.join(root, '.git'))
    return 'alive'
  } catch (error) {
    return gone(error) ? 'dead' : 'unknown'
  }
}

/** 목록 판정 + 파일시스템 확인 — 둘 다 맞아야 죽은 자리다(F1). */
export function confirmedDeadSlot(input: { path: string; worktreePaths: readonly string[]; slotState: (root: string) => SlotState }): boolean {
  const root = deadSlotRoot({ path: input.path, worktreePaths: input.worktreePaths })
  return root !== null && input.slotState(root) === 'dead'
}

/**
 * 사라지는 pane 을 보존해도 되나 — 그 pane 이 실제로 보존될 때(`done`·억제 표 없음)만 store 가 묻는다. false 는 셋이 다 맞을 때만이다:
 *   판정 가능(`cardless` 가 null 이 아님) · 그 workspace 가 카드 밖 · 그 pane 의 cwd 가 주인 없는 쪽
 *   (HOME · 디렉터리 없음(`isDirectory` false 만 — 확인 불가 null 은 있음 쪽) · 확인된 죽은 자리(`isDeadSlot`)).
 * cwd 가 없으면 판정 근거가 없어 보존한다(Resource 「경로 모름」 과 같은 자리).
 */
export function keepRetention(input: {
  workspaceId: string
  cwd: string | null
  cardless: readonly WorkspaceRow[] | null
  homes: readonly string[]
  isDirectory: (path: string) => boolean | null
  isDeadSlot: (path: string) => boolean
}): boolean {
  if (input.cardless === null) return true
  if (!input.cardless.some((workspace) => workspace.workspaceId === input.workspaceId)) return true
  if (input.cwd === null) return true
  const ownerless = input.homes.includes(input.cwd) || input.isDirectory(input.cwd) === false || input.isDeadSlot(input.cwd)
  return !ownerless
}

/** 붙을 카드가 없어진 보존 행 — cwd 가 확인된 죽은 자리인 행의 paneId. 판정 불가면 하나도 걷지 않는다. */
export function prunableRetained(input: { retained: readonly RetainedAgentRow[]; determinable: boolean; isDeadSlot: (path: string) => boolean }): string[] {
  if (!input.determinable) return []
  return input.retained.flatMap((row) => (row.cwd !== null && input.isDeadSlot(row.cwd) ? [row.paneId] : []))
}

/**
 * 경로가 지금 디렉터리인가 — 사라지는 순간 한 번만 묻는 동기 확인(닫힘은 드물다). `checkPath`(resource-ipc)와 같은 뜻:
 * `ENOENT`·`ENOTDIR`·파일이면 false, 그 밖의 stat 오류는 확인 불가(null — 있음 쪽).
 */
export function directoryNow(target: string): boolean | null {
  try {
    return fs.statSync(target).isDirectory()
  } catch (error) {
    return gone(error) ? false : null
  }
}
