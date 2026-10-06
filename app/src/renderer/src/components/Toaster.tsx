// 앱 수준 알림 토스트 (LIFE-527 D9) — Orca 198 과 같은 라이브러리(sonner 2.0.7, MIT)와 같은 설정:
// `App.tsx:106` `<Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />` + `components/ui/sonner.tsx`
// (오른쪽 아래 · 하단 여백 2.5rem — 상태바 위 · 폭 min(26rem, 100vw − 2rem) · popover 칠·테두리·radius).
// 색·폭 변수는 styles.css `.toaster[data-sonner-toaster]` 에 둔다(Orca 는 style prop — corral 은 단언 없이 CSS 로). corral 토큰으로 옮겼다
// (Orca --popover = --bg-raised · --popover-foreground = --fg · --border = --line · --radius .625rem = 10px).
// 톤은 지금 corral 알림이 info 하나뿐이라(D9) 아이콘 없는 기본 토스트만 쓴다 — Orca 아이콘 세트는 쓰는 곳이 생기면 옮긴다.
import { Toaster as Sonner } from 'sonner'

export function Toaster(): React.JSX.Element {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      offset={{ bottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      mobileOffset={{ bottom: 'calc(2.5rem + env(safe-area-inset-bottom, 0px))' }}
      className="toaster group"
      closeButton
      toastOptions={{ className: 'corral-toast' }}
    />
  )
}
