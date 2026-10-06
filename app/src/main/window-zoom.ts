// LIFE-527 — 창 크롬 상태(신호등 위치·렌더러 여백) 동기화. index.ts 의 BrowserWindow 를 구조 타입으로만 받는다 — 단위 시험이
// Electron 없이 돌게(fix1 F1).
import { trafficLightPosition, type WindowChrome } from '../shared/window-chrome.js'

export type ChromeWindow = {
  isDestroyed(): boolean
  isFullScreen(): boolean
  setWindowButtonPosition(position: { x: number; y: number }): void
  webContents: {
    getZoomFactor(): number
    send(channel: 'corral:windowChrome', chrome: WindowChrome): void
    on(event: 'dom-ready', listener: () => void): unknown
  }
}

/** 렌더러가 사이드바 머리를 그리는 데 필요한 창 상태. */
export function windowChromeOf(input: { target: ChromeWindow; mac: boolean }): WindowChrome {
  return { mac: input.mac, fullScreen: input.target.isFullScreen(), zoomFactor: input.target.webContents.getZoomFactor() }
}

export function pushWindowChrome(input: { target: ChromeWindow; mac: boolean }): void {
  if (input.target.isDestroyed()) return
  input.target.webContents.send('corral:windowChrome', windowChromeOf(input))
}

/**
 * LIFE-527 D2 — 줌(View ▸ 확대/축소, Electron 기본 메뉴)이 바뀌면 신호등을 머리 띠의 세로 중심으로 다시 옮긴다
 * (Orca `syncTrafficLightPosition`). 줌 값은 **main 이 자기 webContents 에서 읽는다**(렌더러가 보낸 숫자를 믿지 않는다).
 */
export function syncWindowZoom(input: { target: ChromeWindow; mac: boolean }): void {
  if (input.target.isDestroyed()) return
  if (input.mac) input.target.setWindowButtonPosition(trafficLightPosition(input.target.webContents.getZoomFactor()))
  pushWindowChrome(input)
}

/**
 * fix1 F1 — 시작 줌. Electron 은 호스트 줌을 영속·복원하므로 줌 1 이 아닌 채로 뜰 수 있다. 줌 변화는 main 에 이벤트로
 * 오지 않고 렌더러는 resize 때만 알린다 — 로드 시점(dom-ready, Orca 198 `main-window-state-lifecycle.ts:22`)에 한 번 맞춘다.
 * 새로고침마다 dom-ready 가 다시 오므로 그때도 맞는다.
 */
export function bindStartupZoomSync(input: { target: ChromeWindow; mac: boolean }): void {
  input.target.webContents.on('dom-ready', () => syncWindowZoom(input))
}
