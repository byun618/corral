// LIFE-496 iso-t4.mjs 의 정리 계획 — I/O 없는 순수 함수(단위 테스트용으로 떼어냄, fix6 R6-01).
// 신호 대상 = 이번 실행이 spawn 해 받은 pid 와 그 PPID 자손뿐이다. 경로 후보는 진단이다 — 신호 근거가 아니다(own.mjs 머리말 H1:
// 평탄한 명령줄에서는 argv 경계를 복원할 수 없어 `<경로> backup` 같은 남의 프로필, 그 경로를 읽는 관찰자도 후보가 된다 — 리뷰 r6 R6-01).
// fix5 는 경로 후보를 신호 목록에 넣었다(코디 명세의 잘못 — reviews.md r6). 그 회차의 주입 B after 「clean:true」는 그 경로 신호 덕분이었다.
import { planSignals, selectOwnedByPath } from '../gui-diff/lib/own.mjs'

/**
 * @param spawned `[{pid, label}]` — 이번 실행이 spawn 해 받은 pid (기동 응답의 runtime pid 포함 — 명령줄 매칭으로 얻은 pid 는 넣지 않는다)
 * @param descendantsOf `(pid) => number[]` — PPID 사슬
 * @param processes `[{pid, command}]` — 정리 시점 프로세스 목록
 * @param paths 소유 경로
 * @param preexisting 기동 전부터 그 경로를 쓰던 pid
 * @returns `{ signals, pathCandidates }` — signals 만 신호한다. pathCandidates 는 iso-run.json 에 남기는 진단
 */
export function planCleanup({ spawned, descendantsOf, processes, paths, preexisting, selfPid }) {
  const pathCandidates = selectOwnedByPath({ processes, targets: paths, exclude: preexisting, selfPid }).owned
  const signals = planSignals({ owned: spawned, descendantsOf })
  return { signals, pathCandidates }
}
