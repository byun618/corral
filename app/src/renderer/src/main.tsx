import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 렌더러에서 터진 예외를 main 로그로 되돌린다.
//
// 이것이 없으면 렌더러 예외는 열지 않는 DevTools 콘솔에만 남아 **하네스에는 안 보인다.**
// ⓖ9(xterm.js #5800 — minify 하면 DECRQM 처리에서 ReferenceError)가 실제로 우리 앱에서
// 나는지 재려면 "안 났다"를 증명할 수단이 필요하다 (판정 M5·L6).
window.addEventListener('error', (event) => {
  window.corral.reportProbe('renderer.error', {
    message: String(event.message),
    source: `${event.filename}:${event.lineno}`,
    stack: String(event.error?.stack ?? '').slice(0, 400),
  })
})
window.addEventListener('unhandledrejection', (event) => {
  window.corral.reportProbe('renderer.error', {
    message: String(event.reason),
    source: 'unhandledrejection',
    stack: String(event.reason?.stack ?? '').slice(0, 400),
  })
})

const root = document.getElementById('root')
if (root === null) throw new Error('#root 가 없다')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
