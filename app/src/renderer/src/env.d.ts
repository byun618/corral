import type { Terminal } from '@xterm/xterm'
import type { CorralApi } from '../../shared/types'

declare global {
  interface Window {
    corral: CorralApi
    /**
     * 계측 전용 문 — `control.ts` 의 `term-dump`·`paste` 가 이걸 읽는다.
     * 판정 근거를 **렌더러의 진짜 버퍼**에서 뽑기 위한 것이고 평시 코드는 쓰지 않는다.
     */
    __corralTerm?: Terminal
    /** T7 계측 — 유니코드 폭 모드를 갈아 끼운다. 되돌려주는 값은 실제 `activeVersion` 이다. */
    __corralUnicode?: (mode: '6' | '11' | 'graphemes') => string
  }
}

export {}
