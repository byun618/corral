/* eslint-disable @typescript-eslint/no-require-imports -- Electron CJS 진입점이라 require 를 쓴다 */
/* global require, process, console, globalThis */
// LIFE-637 최종 관문 격리 회차 래퍼 진입점(up.sh 가 <root>/wrap/main.cjs 로 복사).
// l636 hide-window.cjs 와 다른 점: 수집은 창이 **보일 때만** 돌기 때문에(R6ⓒ) 창을 숨기지 않는다. 대신 show·focus 를 showInactive 로 바꾸고
// 활성화 정책을 accessory(dock 없음)로 둬서, 창은 화면에 보이되 앱이 활성화되거나 키 포커스를 가져가지 않게 한다(LIFE-603 K1 포커스 뺏기 완화).
// 관문 스크립트가 main 을 운전하도록 `globalThis.__l637 = { electron }` 를 남긴다 — main 인스펙터(--inspect)에서 최소화·hide·app.hide 를 부른다.
const electron = require('electron')
const { app, BrowserWindow } = electron
const showInactive = BrowserWindow.prototype.showInactive
BrowserWindow.prototype.show = function () { showInactive.call(this) }
for (const name of ['focus', 'moveTop']) BrowserWindow.prototype[name] = function () {}
app.focus = function () {}
app.setActivationPolicy?.('accessory')
app.whenReady().then(() => { app.dock?.hide(); app.setActivationPolicy?.('accessory') })
globalThis.__l637 = { electron, require }
const { pathToFileURL } = require('node:url')
import(pathToFileURL(process.env.L637_MAIN).href).catch((error) => { console.error('[l637] main import', error); app.exit(1) })
