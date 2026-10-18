// 종료 확인 관문 (LIFE-591 E3ⓒ) — 수정된 파일 탭이 있으면 앱 종료(⌘Q·메뉴·Dock)·창 닫기를 **런타임 정리(`stopRuntime`)보다 먼저** 막고 렌더러에 확인을 맡긴다.
//
// 렌더러가 수정 파일 목록을 바뀔 때마다 민다(`setDirty`) — 그러나 그 목록은 **판정에 쓰지 않는다**(수정 r4 R4-A): 마지막 편집 직후 종료하면 새 목록이 main 에 닿기 전에
// `before-quit` 이 와서, 낡은 빈 목록으로 「수정 없음」 을 승인하고 런타임을 닫았다. 그래서 받을 렌더러가 있으면 **늘** 막고 렌더러에 묻는다(왕복) — 렌더러가 그 순간의
// 문서로 판정하고(수정이 없으면 묻지 않고 바로) 승인과 편집 동결을 같은 마이크로태스크에서 한 뒤 `allow` 를 부른다. 목록은 무응답 대화상자 문구·로그에만 쓴다.
// 막으면 `requestConfirm`(렌더러에 「확인해 달라」)만 보내고 아무것도 정리하지 않는다 — 사용자가 취소하면 앱·런타임·터미널은 그대로다.
// 렌더러가 저장/저장 안 함으로 끝내면 `allow()` 뒤 다시 `app.quit()` — 그때부터는 막지 않는다(`before-quit` → 기존 정리 순서 그대로).
// 무응답 렌더러(수정 r1 R1-I) — 렌더러는 요청을 받자마자 `ack()` 한다. `ackTimeoutMs` 안에 오지 않으면 `onUnresponsive`(main 이 직접 「저장하지 않고 종료 / 취소」 를 묻는다)를
// 한 번 부른다. 렌더러가 멈췄다고 종료가 영영 막히지 않게, 그렇다고 묻지 않고 버리지도 않게.
import type { DirtyFile } from '../shared/file-view.js'

export type QuitGate = {
  setDirty: (files: DirtyFile[]) => void
  dirty: () => DirtyFile[]
  /** 종료·창 닫기 입구가 부른다 — true 면 막았다(부른 쪽이 `preventDefault`). 막을 때마다 확인을 요청한다(중복은 렌더러가 거른다). */
  intercept: (via: string) => boolean
  /** 렌더러가 확인 요청을 받았다(무응답 시계를 멈춘다). 무효가 된 세대의 응답이면 false(아무것도 안 함). */
  ack: (gen: number) => boolean
  /** 렌더러 응답의 세대가 지금 요청의 것인가(수정 r5 R5-B). */
  isCurrent: (gen: number) => boolean
  /** 지금 요청을 무효로 — 무응답 대화상자 「취소」 뒤(R5-B). 이미 보낸 요청에 회복한 렌더러가 늦게 답해도 버린다. */
  invalidate: () => void
  /** 렌더러가 확인을 마쳤다 — 이후 종료를 막지 않는다. */
  allow: () => void
  allowed: () => boolean
}

export function createQuitGate(input: {
  /** `gen` = 이 요청의 세대 — 렌더러가 응답(`quitAck`·`confirmQuit`·`quitCancelled`)에 돌려준다. */
  requestConfirm: (gen: number) => boolean
  onUnresponsive?: () => void
  /** 렌더러가 페이지를 싣는 중인가(수정 r5 R5-A) — 그때는 왕복 대신 밀린 목록으로 판정한다(비면 통과, 있으면 막고 묻는다). */
  loading?: () => boolean
  /** 시험 전용(개발 실행 계측) — 옛 판정(밀린 목록이 비면 묻지 않음)으로 왕복을 건너뛴다. 방어선(취소 뒤 복구) 회귀가 낡은 목록 경로를 일부러 만들 때만. */
  trustPushedList?: boolean
  ackTimeoutMs?: number
  log?: (tag: string, data: Record<string, unknown>) => void
}): QuitGate {
  let files: DirtyFile[] = []
  let allowed = false
  // 요청 세대(수정 r5 R5-B) — 무응답 취소로 무효가 되면 올린다. 같은 세대 안의 거듭된 종료 요청은 같은 번호(진행 중 확인을 무효로 만들지 않는다).
  let gen = 1
  let waiting: ReturnType<typeof setTimeout> | null = null
  const stopWaiting = (): void => {
    if (waiting !== null) clearTimeout(waiting)
    waiting = null
  }
  return {
    setDirty: (next) => {
      files = next
    },
    dirty: () => files,
    intercept: (via) => {
      if (allowed) return false
      if (input.trustPushedList === true && files.length === 0) return false
      // 페이지를 싣는 중(다시 불러오기 등) — 옛 문서가 아직 살아 있을 수 있어 「렌더러 없음」 으로 치지 않는다. 왕복은 새 페이지가 받을지 알 수 없으니
      // main 이 받아 둔 목록으로 판정한다: 비면 통과(로딩 중 무응답 대기 없음), 있으면 아래처럼 막고 묻는다(R5-A).
      if (input.loading?.() === true && files.length === 0) {
        input.log?.('quit.intercepted', { via, files: 0, asked: false, loading: true })
        return false
      }
      // 확인을 받을 렌더러가 없으면 막지 않는다(막으면 종료할 길이 없어진다) — 그때 렌더러 쪽 내용도 이미 없다.
      const asked = input.requestConfirm(gen)
      input.log?.('quit.intercepted', { via, files: files.length, asked, gen })
      // 이미 기다리는 중이면 시계를 새로 걸지 않는다(같은 무응답에 대화상자를 두 번 띄우지 않게).
      if (asked && waiting === null && input.onUnresponsive !== undefined) {
        const onUnresponsive = input.onUnresponsive
        waiting = setTimeout(() => {
          waiting = null
          if (allowed) return
          input.log?.('quit.unresponsive', { files: files.length, waitedMs: input.ackTimeoutMs ?? 3000 })
          onUnresponsive()
        }, input.ackTimeoutMs ?? 3000)
      }
      return asked
    },
    ack: (replyGen) => {
      if (replyGen !== gen) return false
      stopWaiting()
      return true
    },
    isCurrent: (replyGen) => replyGen === gen,
    invalidate: () => {
      gen += 1
      stopWaiting()
    },
    allow: () => {
      allowed = true
      stopWaiting()
    },
    allowed: () => allowed,
  }
}

/** 렌더러가 민 목록의 형 검사 — 모르는 모양은 버린다(빈 목록이 아니라 null — 부른 쪽이 기존 값을 지킨다). */
export function parseDirtyFiles(input: unknown): DirtyFile[] | null {
  if (!Array.isArray(input)) return null
  const files: DirtyFile[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) return null
    const root = 'root' in item ? item.root : undefined
    const rel = 'rel' in item ? item.rel : undefined
    if (typeof root !== 'string' || typeof rel !== 'string') return null
    files.push({ root, rel })
  }
  return files
}
