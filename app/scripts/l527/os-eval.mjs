// LIFE-527 — 떠 있는 격리 인스턴스 페이지에 식 하나를 평가해 JSON 으로 찍는다(관측 전용 — 입력은 cliclick 이 한다).
// 실행: node app/scripts/l527/os-eval.mjs <port> '<식>'
//   식은 페이지 안에서 `(() => <식>)()` 로 돈다. 프라미스면 기다린다.
import { connect } from '../gui-diff/lib/cdp.mjs'

const [port, expression] = process.argv.slice(2)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const pages = list.filter((entry) => entry.type === 'page' && !entry.url.startsWith('devtools://'))
if (pages.length !== 1) throw new Error(`page 가 ${pages.length}개 — ${JSON.stringify(pages.map((page) => page.url))}`)
const cdp = await connect(pages[0].webSocketDebuggerUrl)
const result = await cdp.send('Runtime.evaluate', { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true })
if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
console.log(JSON.stringify(result.result.value))
process.exit(0)
