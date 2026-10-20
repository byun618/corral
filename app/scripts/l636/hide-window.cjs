/* eslint-disable @typescript-eslint/no-require-imports -- Electron CJS 진입점이라 require 를 쓴다 */
/* global require, process, console */
// LIFE-636 최종 관문 격리 회차 — 제품 main 을 **창을 띄우지 않고** 돌린다(LIFE-603 K1 포커스 뺏기 회피).
// iso-up.sh 가 만든 래퍼 앱(<root>/wrap, package.json main = 이 파일의 사본)의 진입점이다. 창의 show·focus 계열을 무효로 하고
// dock·활성화 정책을 숨긴 **뒤에** 제품 main(`L636_MAIN` = app/out/main/index.js)을 import 한다.
// 렌더러는 그대로 그려진다(show:false 창 + paintWhenInitiallyHidden 기본값) — 확인은 CDP 로 한다.
// 차이: app.getAppPath() 가 래퍼 폴더다 — 제품은 개발 guard herdr 찾기에만 쓰고, 격리 회차는 CORRAL_SESSION 바인딩이라 그 길을 타지 않는다.
const { app, BrowserWindow } = require('electron')
for (const name of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[name] = function () {}
app.focus = function () {}
app.setActivationPolicy?.('accessory')
app.whenReady().then(() => { app.dock?.hide(); app.setActivationPolicy?.('accessory') })
const { pathToFileURL } = require('node:url')
import(pathToFileURL(process.env.L636_MAIN).href).catch((error) => { console.error('[l636] main import', error); app.exit(1) })
