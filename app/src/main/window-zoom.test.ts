// LIFE-527 fix1 F1 — 시작 줌 동기화. 창·webContents 는 구조 타입 가짜로 대신한다.
import { describe, expect, it } from 'vitest'
import type { WindowChrome } from '../shared/window-chrome.js'
import { bindStartupZoomSync, syncWindowZoom, type ChromeWindow } from './window-zoom.js'

function fakeWindow(input: { zoom: number }) {
  const listeners: Array<() => void> = []
  const buttons: Array<{ x: number; y: number }> = []
  const sent: WindowChrome[] = []
  const state = { zoom: input.zoom, destroyed: false }
  const target: ChromeWindow = {
    isDestroyed: () => state.destroyed,
    isFullScreen: () => false,
    setWindowButtonPosition: (position) => buttons.push(position),
    webContents: {
      getZoomFactor: () => state.zoom,
      send: (_channel, chrome) => sent.push(chrome),
      on: (_event, listener) => listeners.push(listener),
    },
  }
  return { target, state, buttons, sent, domReady: () => listeners.forEach((listener) => listener()) }
}

describe('bindStartupZoomSync — 시작 줌 (fix1 F1)', () => {
  it('줌 1.0954(⌘+ 1단계) 로 복원된 창은 dom-ready 에서 신호등을 y 13 으로 옮기고 상태를 민다 — resize 없이', () => {
    const w = fakeWindow({ zoom: 1.0954451150103321 })
    bindStartupZoomSync({ target: w.target, mac: true })
    expect(w.buttons).toEqual([])
    w.domReady()
    expect(w.buttons).toEqual([{ x: 16, y: 13 }])
    expect(w.sent).toEqual([{ mac: true, fullScreen: false, zoomFactor: 1.0954451150103321 }])
  })

  it('줌 값은 dom-ready 시점의 webContents 에서 읽는다 — 묶을 때 값이 아니다', () => {
    const w = fakeWindow({ zoom: 1 })
    bindStartupZoomSync({ target: w.target, mac: true })
    w.state.zoom = 0.9128709291752769
    w.domReady()
    expect(w.buttons).toEqual([{ x: 16, y: 10 }])
  })

  it('새로고침마다 dom-ready 가 다시 오면 그때 줌으로 다시 맞춘다', () => {
    const w = fakeWindow({ zoom: 1 })
    bindStartupZoomSync({ target: w.target, mac: true })
    w.domReady()
    w.state.zoom = 1.2
    w.domReady()
    expect(w.buttons).toEqual([{ x: 16, y: 12 }, { x: 16, y: 15 }])
  })

  it('mac 이 아니면 신호등을 건드리지 않고 상태만 민다', () => {
    const w = fakeWindow({ zoom: 1.2 })
    bindStartupZoomSync({ target: w.target, mac: false })
    w.domReady()
    expect(w.buttons).toEqual([])
    expect(w.sent).toEqual([{ mac: false, fullScreen: false, zoomFactor: 1.2 }])
  })

  it('파괴된 창이면 아무것도 하지 않는다', () => {
    const w = fakeWindow({ zoom: 1.2 })
    w.state.destroyed = true
    syncWindowZoom({ target: w.target, mac: true })
    expect(w.buttons).toEqual([])
    expect(w.sent).toEqual([])
  })
})
