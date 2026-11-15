// provider 세션 마커 허용 목록 — CLI(`corral open`)·앱(herdr 서버 env)·에이전트 기동이 같은 목록을 쓴다 (LIFE-555 A5).
// 원래 `runtime/terminal/agent.ts` 에 있던 것을 main 쪽 herdr 서버 env 도 쓰게 여기로 옮겼다 — agent.ts 는 다시 내보낸다.

/**
 * A corral CLI launched from inside an agent inherits that agent's session markers, and a child
 * provider then treats itself as a nested session and stops writing a record (§8.2, findings E11).
 * The removal is an allowlist, not a pattern: CODEX_HOME, GROK_HOME and CLAUDE_CONFIG_DIR must
 * survive or the child writes somewhere corral is not looking.
 *
 * `CLAUDE_JOB_DIR` is the background-session marker (LIFE-795): Claude Code gives it to every background session
 * and no foreground one, and the bundled herdr's Claude hook stays silent where it is set. corral started from a
 * background session's shell would otherwise hand it to every pane shell it starts, and the foreground claude in
 * those panes would never report its session (fail silent).
 */
export const SESSION_MARKER_NAMES: readonly string[] = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR']
export const SESSION_MARKER_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'ORCA_AGENT_HOOK_']
export function isSessionMarker(name: string): boolean {
    return SESSION_MARKER_NAMES.some(marker => marker === name) || SESSION_MARKER_PREFIXES.some(prefix => name.startsWith(prefix))
}
export function strippedSessionMarkers(environment: Record<string, string | undefined>): string[] {
    return Object.keys(environment).filter(isSessionMarker).sort()
}
export function withoutSessionMarkers(environment: Record<string, string | undefined>): Record<string, string | undefined> {
    const copy = { ...environment }
    for (const name of strippedSessionMarkers(environment)) delete copy[name]
    return copy
}
