// 격리 드라이버의 마지막 판정 (LIFE-512 fix1 R1-05) — 검사가 다 통과해도 끝에 프로세스가 남았으면 실패다.
// iso-u9 와 같은 규칙(남으면 4). 이미 실패한 회차는 그 종료코드를 그대로 둔다 — 먼저 난 원인을 덮지 않는다.
export const LEFTOVER_EXIT = 4

export function finalExit({ exitCode, left }) {
  const leftover = left.trim() !== ''
  return { exitCode: exitCode === 0 && leftover ? LEFTOVER_EXIT : exitCode, leftover }
}

/** 원장 「통과/실패」 칸 — 잔존이 있으면 이유에 반드시 적는다(검사 실패와 겹쳐도). */
export function ledgerResult({ exitCode, leftover, error, failed }) {
  if (exitCode === 0) return '통과'
  const reasons = []
  if (error) reasons.push(error.split('\n')[0])
  if (failed.length > 0) reasons.push(failed.join(', '))
  if (leftover) reasons.push('끝에 프로세스 잔존(guard-after.txt)')
  return `실패 — ${reasons.join(' · ')}`
}
