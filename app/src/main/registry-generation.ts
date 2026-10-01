// 레지스트리 세대 (LIFE-469 R2-01·R3-01) — 등록 목록이 **실제로 바뀐 것을 관측할 때마다** 1 오른다.
//
// 세대를 GUI 함수(main `addRepo`·`removeRepo`)에서만 올리면, CLI `repo add`·`project setup-*` 처럼 runtime 의
// `workspaceModule` 이 자기 `RepoRegistry` 로 파일을 고치는 경로가 빠진다(리뷰 r3 CDX-R3-01). 그래서 쓰는 쪽이 아니라
// **읽는 쪽**에서 센다 — main 이 상태를 내보낼 때(`currentState`)와 제거 직후에 `registry.list()` 를 대 보고, 직전에
// 본 목록과 다르면 올린다. 어느 경로로 바뀌었든(GUI·CLI·앱 밖 파일 편집) 다음 관측에서 세대가 오른다.
//
// 렌더러는 이 값으로 「제거 뒤에 다시 등록됐다」를 옛 스냅샷과 구분한다(`useManualOrder`): 제거 관측 세대보다 큰 세대에서
// 그 root 가 목록에 있으면 재등록이다. 두 관측 사이에 같은 root 가 빠졌다 다시 들어오면(앱 밖에서) 목록이 같아 세대가
// 오르지 않지만, 그때는 GUI 제거(`forget`)가 끼지 않았으니 대기 키도 없다.

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
