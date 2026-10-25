// 죽은 worktree 자리 (LIFE-694·695·697 공용 판정).
//
// corral 이 worktree 를 만드는 유일한 자리는 `<repo>/.claude/worktrees/<name>` 이다(`runtime/workspace/index.ts`,
// `shared/work-start.ts startWorktreePath`). 그 자리의 경로인데 git 이 아는 worktree 목록에 그 자리를 품는 worktree 가
// 없으면 「지워진 worktree 의 자리」다 — 폴더가 남았든(빌드 결과만 남은 잔재) 사라졌든.
//
// 근거는 **worktree 목록과 자리 모양뿐**이다. 잔재 폴더 안에서는 `git rev-parse` 가 main 레포로 성공한다(main checkout 안이라) —
// git 명령 성공을 worktree 근거로 쓰지 않는다(697 함정).
//
// 판정: 경로를 품는 가장 구체적인(가장 긴) worktree 가 그 경로의 `.claude/worktrees/<name>` 부모라면 죽은 자리다.
// 그 자리의 worktree 가 살아 있었다면 그것이 가장 긴 것으로 이겼을 것이다. 목록이 비었으면(git 읽기 실패) 품는 것이 없어
// 죽은 자리가 아니다 — 모르면 「경로 있음」 쪽(G1).

const SLOT = '.claude/worktrees/'

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function isDeadWorktreeSlot(input: { path: string; worktreePaths: readonly string[] }): boolean {
  const target = trimSlash(input.path)
  let best: string | null = null
  for (const raw of input.worktreePaths) {
    const path = trimSlash(raw)
    const inside = target === path || target.startsWith(path === '/' ? '/' : `${path}/`)
    if (inside && (best === null || path.length > best.length)) best = path
  }
  if (best === null || best === target) return false
  const rest = target.slice(best === '/' ? 1 : best.length + 1)
  if (!rest.startsWith(SLOT)) return false
  const name = rest.slice(SLOT.length).split('/')[0] ?? ''
  return name.length > 0
}
