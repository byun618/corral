// LIFE-590 R10 — 빌드 산출물(file://)에서 Monaco editor worker 가 CSP 변경 없이 뜨는지. 양성 대조 2개(없는 파일·data: worker)와 함께 본다.
// 성공 판정 = 실제 worker 에 메시지를 보내 응답(onmessage) 또는 3초 동안 error 없음. 대조는 error 이벤트가 나야 한다(못 보는 계측이 아님을 보인다).
// 사용(app/ 에서): node scripts/l590/worker-probe.mjs --root /tmp/l590g-e --out <file.json>
import { parseArgs } from 'node:util'
import { checkRoot, evalJs, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const probe = (url) => `new Promise((resolve) => {
  let worker
  try { worker = new Worker(${url}, { type: 'module' }) } catch (error) { resolve({ result: 'throw', message: String(error) }); return }
  const timer = setTimeout(() => { worker.terminate(); resolve({ result: 'no-error-3s' }) }, 3000)
  worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); resolve({ result: 'error', message: event.message ?? null }) }
  worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); resolve({ result: 'message', type: typeof event.data }) }
})`
const realUrl = await evalJs(values.root, `[...document.scripts].map((s) => s.src).find((src) => src.includes('/assets/'))?.replace(/[^/]+$/, '') ?? null`)
const assets = await evalJs(values.root, `location.href`)
const result = {
  page: assets,
  csp: await evalJs(values.root, `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null`),
  real: await evalJs(values.root, probe(`${JSON.stringify(realUrl)} + 'editor.worker-DD3EztIk.js'`)),
  missing: await evalJs(values.root, probe(`${JSON.stringify(realUrl)} + 'no-such-worker.js'`)),
  dataUrl: await evalJs(values.root, probe(`'data:text/javascript,postMessage(1)'`)),
  monacoWorker: await evalJs(values.root, `typeof self.MonacoEnvironment?.getWorker`),
}
writeJson(values.out, result)
console.log(JSON.stringify(result))
const pass = (result.real.result === 'no-error-3s' || result.real.result === 'message') && result.missing.result !== 'no-error-3s' && result.dataUrl.result !== 'no-error-3s'
process.exit(pass ? 0 : 1)
