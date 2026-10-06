// LIFE-526 fix1 R1-02 — 자식 실행 결과를 래퍼 종료코드로 옮긴다. 타임아웃·시그널·spawn 오류(status === null)는 **nonzero**(2)다.
// 전에는 `process.exit(run.status)` 라 status null 이 exit 0 이 됐다(Codex r1 재현: timeout → status null · SIGTERM · ETIMEDOUT → exit 0).
// run: spawnSync 결과 또는 같은 꼴 { status, signal, error }. 돌려주는 값: { code, note } — note 는 원자료(stdout.log)에 남길 한 줄.
export function childExit({ run }) {
  const error = run.error ? String(run.error?.code ?? '') + (run.error?.message ? ` ${run.error.message}` : '') : null
  if (run.error || run.signal || run.status === null || run.status === undefined) {
    return { code: 2, note: `child: 실패 — status=${run.status ?? 'null'} signal=${run.signal ?? 'null'} error=${error ?? 'null'} → exit 2` }
  }
  return { code: run.status, note: `child: status=${run.status} signal=null error=null → exit ${run.status}` }
}
