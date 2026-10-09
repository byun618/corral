// 폰 화면 장부 파일 (LIFE-580) — 안 읽음(J1)·접힘 기억. 앱 문서 폴더의 평범한 JSON 이다.
// **토큰 금고(SecureStore)와 섞지 않는다** — 비밀이 아니고, 지워져도 첫 설치처럼(전부 읽음·기본 접힘) 돌아갈 뿐이다.
import { File, Paths } from 'expo-file-system'
import { readCollapseData, type CollapseStore } from '../core/collapse'
import { readUnreadData, type UnreadStore } from '../core/unread'

function jsonFile<T>(name: string, read: (value: unknown) => T): { load(): T | null; save(data: T): void } {
  const file = () => new File(Paths.document, name)
  return {
    load() {
      try {
        const target = file()
        if (!target.exists) return null
        return read(JSON.parse(target.textSync()))
      } catch {
        return null
      }
    },
    save(data) {
      try {
        const target = file()
        if (!target.exists) target.create()
        target.write(JSON.stringify(data))
      } catch {
        // 장부는 보조 — 쓰기 실패가 목록을 막지 않는다(다음 실행은 첫 설치처럼).
      }
    },
  }
}

export const unreadFile: UnreadStore = jsonFile('unread.json', readUnreadData)
export const collapseFile: CollapseStore = jsonFile('collapse.json', readCollapseData)
