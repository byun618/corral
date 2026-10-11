// RN WebSocket → 연결 관리자의 `SocketLike`. 관리자가 핸들러를 떼면(null) 이 어댑터가 아무것도 넘기지 않는다.
//
// 개발 전용 접속(에뮬레이터): 에뮬레이터는 tailnet 주소를 쓸 수 없고, loopback·10.0.2.2 로 붙으면 RN 이 만드는 Origin 이 서버 규칙에 걸린다
// (SURFACE §2 Origin — 서버 규칙은 바꾸지 않는다). 그래서 **개발 변형(APP_VARIANT=development) + 개발 번들(__DEV__)** 에서만
// `EXPO_PUBLIC_DEV_ENDPOINT`(예: ws://10.0.2.2:<서버 포트>/ws)로 실제 바이트를 보내고, Origin 헤더는 QR 주소에서 RN 이 만들었을 값
// (`https://<host>:8577`)을 그대로 단다 — 실기에서 서버가 보는 것과 같은 Origin 이다. 배포 번들은 `__DEV__` 가 거짓이라 이 가지가 없다.
import Constants from 'expo-constants'
import type { SocketLike } from '../core/connection'
import { originOf } from '../core/payload'

/** RN 의 WebSocket 은 셋째 인자(headers)를 받는다 — 타입 정의는 DOM 쪽이 이겨 두 인자만 보이므로 모양을 따로 적는다. */
type HeaderSocketCtor = new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocket
const HeaderSocket: HeaderSocketCtor = WebSocket

const variant: unknown = Constants.expoConfig?.extra?.variant
const devEndpoint = __DEV__ && variant === 'development' ? process.env.EXPO_PUBLIC_DEV_ENDPOINT : undefined

export function devEndpointActive(): boolean {
  return typeof devEndpoint === 'string' && devEndpoint.length > 0
}

export function openSocket(url: string): SocketLike {
  const origin = originOf(url)
  const ws =
    typeof devEndpoint === 'string' && devEndpoint.length > 0 && origin !== null
      ? new HeaderSocket(devEndpoint, undefined, { headers: { origin } })
      : new WebSocket(url)
  const adapter: SocketLike = {
    get readyState() {
      return ws.readyState
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = () => adapter.onopen?.({})
  ws.onmessage = (event) => adapter.onmessage?.({ data: event.data })
  ws.onclose = (event) => adapter.onclose?.({ code: event.code })
  ws.onerror = () => adapter.onerror?.({})
  return adapter
}
