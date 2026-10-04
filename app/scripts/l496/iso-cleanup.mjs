// LIFE-496 iso-t4.mjs 의 정리 계획 — I/O 없는 순수 함수(단위 테스트용으로 떼어냄, fix6 R6-01).
import { planSignals, selectOwnedByPath } from '../gui-diff/lib/own.mjs'

/**
 * @param spawned `[{pid, label}]` — 이번 실행이 spawn 해 받은 pid
 * @param descendantsOf `(pid) => number[]` — PPID 사슬
 * @param processes `[{pid, command}]` — 정리 시점 프로세스 목록
 * @param paths 소유 경로
 * @param preexisting 기동 전부터 그 경로를 쓰던 pid
 * @returns `{ signals, pathCandidates }`
 */
export function planCleanup({ spawned, descendantsOf, processes, paths, preexisting, selfPid }) {
  const signallablePaths = paths.filter((item) => !/\s/.test(item))
  const pathCandidates = selectOwnedByPath({ processes, targets: signallablePaths, exclude: preexisting, selfPid }).owned
  const signals = planSignals({
    owned: [...spawned, ...pathCandidates.map((entry) => ({ pid: entry.pid, label: `소유 경로 확인 ${entry.path}` }))],
    descendantsOf,
  })
  return { signals, pathCandidates }
}
