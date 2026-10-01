// 레지스트리 세대 (LIFE-469 R2-01·R3-01·R4-01) — 관측한 등록 목록이 **직전 관측과 다를 때** 1 오른다.
//
// 세대를 GUI 함수(main `addRepo`·`removeRepo`)에서만 올리면, CLI `repo add`·`project setup-*` 처럼 runtime 의
// `workspaceModule` 이 자기 `RepoRegistry` 로 파일을 고치는 경로가 빠진다(리뷰 r3 CDX-R3-01). 그래서 쓰는 쪽이 아니라
// **읽는 쪽**에서 센다 — main 이 상태를 내보낼 때(`currentState`)와 GUI 제거 때 관측한다. 세대는 변경 **횟수**가 아니다:
// 관측 사이의 여러 변경은 한 번으로 합쳐지고, 관측 사이에 원래 목록으로 돌아온 변경은 세지 않는다.
//
// 보장(렌더러 `useManualOrder` 가 기대는 것): GUI 제거의 응답 세대는 `removeObserved` 가 **제거 트랜잭션 안(잠금 보유 중)
// 의 목록** — 그 root 가 없는 목록 — 으로 관측한 값이다(R4-01: 잠금이 풀린 뒤 `list()` 를 다시 읽으면 그 틈에 다른
// 작성자가 그 root 를 다시 등록한 목록을 보고 세대가 안 오를 수 있었다). main 은 한 스레드라 이 관측과 다음 관측 사이에
// 다른 관측이 끼지 않는다. 그래서 그 뒤 어느 관측에서든 그 root 가 등록돼 있으면 목록이 반드시 달라 세대가 더 크다 —
// 재등록이 GUI·CLI·앱 밖 어느 쪽이든.
// 한계: 관측은 main 이 상태를 낼 때만 일어난다 — CLI·앱 밖 재등록은 다음 상태 emit 때 세대에 반영된다(그 전까지 대기 유지).

import type { RemoveRepoResult } from '../shared/types.js'
import type { RepoRegistry } from './registry.js'

export class RegistryGeneration {
  private generation = 0
  private seen: string | null = null

  /** 지금 등록 목록을 관측한다 — 직전 관측과 다르면 세대를 올리고, 지금 세대를 돌려준다. 첫 관측은 0 이다. */
  observe(roots: readonly string[]): number {
    const key = JSON.stringify([...roots].sort())
    if (this.seen !== null && key !== this.seen) this.generation++
    this.seen = key
    return this.generation
  }
}

/** GUI 제거 + 관측 — 응답 세대를 제거 트랜잭션 안의 목록(`rootsAfter`)에 묶는다(R4-01). main `removeRepo` 가 쓴다. */
export function removeObserved(input: { registry: RepoRegistry; generation: RegistryGeneration; root: string }): RemoveRepoResult {
  const { rootsAfter, ...result } = input.registry.remove(input.root)
  if (!result.ok || rootsAfter === undefined) return result
  return { ...result, registryGeneration: input.generation.observe(rootsAfter) }
}
