// LIFE-527 — 창 크롬 상태(macOS 여부·전체화면·줌)를 main 에서 받는다. 사이드바 머리의 신호등 여백(D3)과 그 폭(D2)이 여기에 달린다.
// 줌 변화는 main 에 이벤트로 오지 않는다 — 줌이 바뀌면 뷰포트가 바뀌어 resize 가 오므로 그때 main 에 다시 읽으라고 알린다.
import { useEffect, useState } from 'react'
import type { WindowChrome } from '../../../shared/window-chrome.js'

// 첫 응답 전 추정 — macOS 면 여백을 둔 채 시작한다(신호등이 머리 위에 겹쳐 보이는 깜빡임을 피한다).
const INITIAL: WindowChrome = { mac: /Mac/.test(navigator.userAgent), fullScreen: false, zoomFactor: 1 }

export function useWindowChrome(): WindowChrome {
  const [chrome, setChrome] = useState<WindowChrome>(INITIAL)
  useEffect(() => {
    let live = true
    void window.corral.getWindowChrome().then((value) => {
      if (live && value) setChrome(value)
    })
    const off = window.corral.onWindowChrome((value) => setChrome(value))
    const onResize = (): void => window.corral.syncWindowZoom()
    window.addEventListener('resize', onResize)
    return () => {
      live = false
      off()
      window.removeEventListener('resize', onResize)
    }
  }, [])
  useEffect(() => {
    // Orca `.titlebar-traffic-light-pad { width: calc(80px / var(--ui-zoom-factor)) }` — 줌해도 신호등(OS 픽셀)이 차지하는 폭은 그대로다.
    document.documentElement.style.setProperty('--ui-zoom-factor', String(chrome.zoomFactor))
  }, [chrome.zoomFactor])
  return chrome
}
