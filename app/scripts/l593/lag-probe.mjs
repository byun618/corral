// LIFE-593 수정 r2 R2-C-06 — FileLister.list 동안 main 이벤트 루프 최대 간격(2 ms 간격 타이머). 리뷰 r2 `probes/p2-lag.mts` 를 옮김.
// 한글 경로 12만(`kor-fixture.py` → /tmp/l593f-kor120k/repo)에서 `toDiskNames` 가 덩이마다 양보하는지 본다. 3회.
// 사용(app/ 에서): npx tsx scripts/l593/lag-probe.mjs <REPO>
import { FileLister, resolveGit } from '../../src/main/file-list.ts'

const repo = process.argv[2] ?? ''
const lister = new FileLister({ roots: () => [repo], git: () => resolveGit({ pathEnv: process.env.PATH }), log: () => undefined })
for (let round = 0; round < 3; round += 1) {
  let last = performance.now()
  let max = 0
  const timer = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last)
    last = now
  }, 2)
  const startedAt = performance.now()
  const result = await lister.list({ root: repo, includeIgnored: false, requestId: `lag${round}` })
  clearInterval(timer)
  console.log(JSON.stringify({ round, ok: result.ok, count: result.ok ? result.count : null, totalMs: Math.round(performance.now() - startedAt), maxLoopGapMs: Math.round(max) }))
}
