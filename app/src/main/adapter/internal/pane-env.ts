// LIFE-565 C6 — corral 이 herdr 에 새 pane 을 만들 때 실어 보내는 env(herdr API `env`, pane 단위).
//
// `FORCE_HYPERLINK=1`: Claude Code 등 `supports-hyperlinks` 계열은 TERM_PROGRAM 허용 목록 밖 터미널(corral pane 은 TERM=xterm-256color 뿐)에서
// OSC 8 을 내지 않는다(00-analysis F1, C1ⓒ 실측 0). Orca 도 pane env 에 같은 값을 넣는다. 다른 키는 넣지 않는다(02-kickoff 범위 변경 A).
// herdr 는 이 값을 서버 env 위에 키 단위로 덮어 쓴다(`pane.rs` apply_pane_launch_env) — 서버 env·재시작은 건드리지 않는다.
export const PANE_ENV: Readonly<Record<string, string>> = { FORCE_HYPERLINK: '1' }

/** 요청마다 새 객체 — 상수를 요청 params 로 그대로 넘겨 공유하지 않는다. */
export function paneEnv(): Record<string, string> {
  return { ...PANE_ENV }
}
