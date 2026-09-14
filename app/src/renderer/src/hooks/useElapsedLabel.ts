// 세션 행의 "경과 시간" (design-handoff.md §2 SessionRow).
//
// **데이터 모델 한계**: `TabRow` 에는 생성 시각이 없다 (herdr 가 안 준다 — `app/src/shared/types.ts`
// 권위, 이 파일이 확장 대상 아니다: 02-kickoff-orca.md "corral 데이터 모델은 안 바뀐다"). 그래서
// "진짜 생성 후 경과"가 아니라 **이 렌더러 프로세스가 그 tabId 를 처음 관측한 시각부터의 경과**다 —
// 앱 기동 전부터 있던 탭은 실제보다 짧게 보인다. 근사치라는 것을 결과 문서에 명시한다(C9′ 결과 문서).

const firstSeenAt = new Map<string, number>()

function markSeen(tabId: string): number {
  const existing = firstSeenAt.get(tabId)
  if (existing !== undefined) return existing
  const now = Date.now()
  firstSeenAt.set(tabId, now)
  return now
}

export function elapsedLabel(tabId: string, now: number = Date.now()): string {
  const since = markSeen(tabId)
  const ms = Math.max(0, now - since)
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
