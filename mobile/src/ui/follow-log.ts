// 대화 맨 아래 따라가기 진단 로그 (LIFE-595 C1) — 제스처 경계·보류 중 크기 변화·꼬리 변경·settle 결정을 logcat 에 한 줄씩.
// 연결 기록(`[corral-conn]`, core/log.ts)과 따로다 — 「연결 기록」 화면·파일에 싣지 않고 console 로만 낸다(RN Android 는 logcat `ReactNativeJS`).
// 사용자 내용 없음: 칸은 숫자·참거짓·상태 이름만 받는다(말풍선 글·도구 출력을 넣을 자리가 없다). onScroll 마다 부르지 않는다 — 경계·결정에서만.

export const FOLLOW_TAG = '[corral-follow]'

export type FollowValue = number | boolean | 'none' | 'drag' | 'release' | 'momentum' | 'layout' | 'follow' | 'button' | 'wait' | 'hold' | 'skip' | 'seen' | 'drop'

export function followLog(event: string, fields: Record<string, FollowValue>): void {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value * 10) / 10 : String(value)}`)
  console.log([FOLLOW_TAG, event, ...parts].join(' '))
}
