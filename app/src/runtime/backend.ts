// 런타임이 모는 terminal backend (LIFE-556).
//
// 명시 바인딩 — `CORRAL_BACKEND_SOCKET`+`CORRAL_SESSION`(프로필 복원 포함, `restoreBackend`) — 이 언제나 먼저다.
// 없을 때만 설치본 GUI 가 지금 붙어 있는 동봉 서버를 쓴다(`useBundledBackend`). GUI 의 현재 연결을 그대로 읽으므로
// GUI 와 CLI 가 서로 다른 서버를 볼 수 없다. 이 바인딩은 프로필에 저장하지 않는다 — 저장하면 다음 기동에서
// 명시 바인딩으로 읽혀 GUI 가 동봉 서버를 띄우지 않는다(`decideBackend` 의 지정 세션 규칙).

/** `session` — 명시 바인딩에서 `CORRAL_SESSION` 이 없으면 null(종전대로 소켓만으로 돈다 — 시작 시 반쪽 바인딩은 `startRuntime` 이 거절한다). */
export type BackendBinding = { socket: string; session: string | null; source: 'explicit' | 'bundled' }

let bundled: (() => { socket: string; session: string } | null) | null = null

/** 설치본 main 만 부른다. 개발 실행·headless CLI 런타임은 부르지 않는다 — 종전대로 명시 바인딩만 쓴다. */
export function useBundledBackend(provider: (() => { socket: string; session: string } | null) | null): void {
  bundled = provider
}

export function backendBinding(env: NodeJS.ProcessEnv = process.env): BackendBinding | null {
  const socket = env.CORRAL_BACKEND_SOCKET, session = env.CORRAL_SESSION
  // 종전 읽기 그대로 — 소켓이 있으면 그 소켓이다.
  if (socket) return { socket, session: session || null, source: 'explicit' }
  // 세션만 지정된 것은 명시 바인딩의 반쪽이다 — 동봉 서버로 메우지 않는다.
  if (session) return null
  const found = bundled?.() ?? null
  return found === null ? null : { ...found, source: 'bundled' }
}

/**
 * Dispatch 가 기록할 pane 세션 이름. herdr 는 default 세션 pane 에 `HERDR_SESSION` 을 싣지 않으므로(0.9.0 `session.rs`
 * `normalize_name`) `default` 를 적으면 그 pane 의 보고가 전부 `sender_mismatch` 가 된다 — 기록하지 않는다(소켓이 증인이다).
 */
export function paneSessionName(binding: BackendBinding | null): string | null {
  if (binding === null || binding.session === 'default') return null
  return binding.session
}
