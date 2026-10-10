// LIFE-588 R1-A1 — 묶음 불변식이 깨진 목록 메시지(리뷰 r1 재현 두 조건 + 루트 행 뒤섞임). 단위·화면 시험이 같이 쓴다.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** feature 작업 채널 배열을 바꾼 메시지. */
export function withFeatChannels(message: Record<string, unknown>, change: (channels: Record<string, unknown>[]) => Record<string, unknown>[]): Record<string, unknown> {
  const list = message.list
  if (!isRecord(list) || !Array.isArray(list.repos)) throw new Error('모양')
  return {
    ...message,
    list: {
      ...list,
      repos: list.repos.map((repo: unknown) => {
        if (!isRecord(repo) || !Array.isArray(repo.tasks)) return repo
        return {
          ...repo,
          tasks: repo.tasks.map((task: unknown) => {
            if (!isRecord(task) || task.name !== 'feature/LIFE-564-mobile' || !Array.isArray(task.channels)) return task
            return { ...task, channels: change(task.channels.filter(isRecord)) }
          }),
        }
      }),
    },
  }
}

/** 리뷰 r1 재현 두 조건 — ① 한 채널 group 을 모르는 id 로(유효 덩어리 가운데) ② 묶음 A 채널 하나를 B 뒤로. */
export const MALFORMED: { name: string; change: (channels: Record<string, unknown>[]) => Record<string, unknown>[] }[] = [
  { name: '① 모르는 group', change: (channels) => channels.map((item) => (item.id === 'a2' ? { ...item, group: 'ffffffffffffffff' } : item)) },
  {
    name: '② 불연속 묶음',
    change: (channels) => {
      const moved = channels.filter((item) => item.id === 'a3')
      const rest = channels.filter((item) => item.id !== 'a3')
      const at = rest.findIndex((item) => item.id === 'b1')
      return [...rest.slice(0, at + 1), ...moved, ...rest.slice(at + 1)]
    },
  },
  // ③ 루트 쪽(group null) 행이 묶음 뒤에 — 머리 아래 남의 행이 붙는 같은 모양.
  { name: '③ 묶음 뒤 루트 행', change: (channels) => [...channels.filter((item) => item.id !== 'f2'), ...channels.filter((item) => item.id === 'f2')] },
]

