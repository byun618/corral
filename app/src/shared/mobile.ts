// 설정 › Mobile 이 보는 모양 (LIFE-577) — main(`main/mobile/`)과 렌더러가 같이 본다.
// **토큰·코드는 `MobileStatus` 에 없다** — push(`corral:mobile`)로 나가는 것은 이것뿐이다. 코드는 `MobilePairingResult` 로,
// 사용자가 「QR 만들기」 를 누른 그 요청의 응답에만 한 번 실린다.

export type MobileCheckState = 'ok' | 'fail' | 'unknown'
export type MobileCheck = { state: MobileCheckState; detail: string }
/** 점검표 4줄 [A7ⓐ] — CLI 있음 · 로그인 · HTTPS 인증서 · Funnel 꺼짐. */
export type MobileChecklist = { cli: MobileCheck; loggedIn: MobileCheck; https: MobileCheck; funnelOff: MobileCheck }

export type MobileBlockReason = 'cli' | 'logged_out' | 'https' | 'funnel' | 'unreadable'

export type MobileExposure =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'blocked'; reason: MobileBlockReason; message: string }
  | { kind: 'foreign'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'exposed'; url: string; host: string; httpsPort: number }

export type MobileDevice = { id: string; name: string; pairedAt: number; lastSeenAt: number | null; connected: boolean }

export type MobileStatus = {
  enabled: boolean
  /** loopback 서버 포트 — 꺼져 있으면 null. */
  serverPort: number | null
  checklist: MobileChecklist
  exposure: MobileExposure
  /** 켜진 동안 Funnel 감지로 항목을 내렸을 때의 경고. */
  warning: string | null
  devices: MobileDevice[]
  maxDevices: number
  /** 유효한 페어링 코드가 있으면 만료 시각. 코드 자체는 싣지 않는다. */
  pairingExpiresAt: number | null
}

/** QR — 모듈 격자를 '1'/'0' 글자로(행 우선, size×size). 렌더러가 SVG 로 그린다(CSP: data-URL 이미지 금지). */
export type MobileQr = { size: number; cells: string }

export type MobilePairingResult =
  | { ok: true; code: string; expiresAt: number; url: string; payload: string; qr: MobileQr }
  | { ok: false; error: string }
