// 격리 세션의 pane 에 한 줄 친다 — 부하를 걸 유일한 수단이다 (CLI 에는 입력 명령이 없다).
// 사용: node scripts/l373impl/type.mjs <paneId> <명령...>
import { clientSocketPath, loadEndpointClient, paneList, sleep } from './lib.mjs'

const paneId = process.argv[2]
const command = process.argv.slice(3).join(' ')
if (!paneId || command.length === 0) throw new Error('사용: type.mjs <paneId> <명령...>')
if (!paneList().some((pane) => pane.pane_id === paneId)) throw new Error(`pane 이 없다: ${paneId}`)

const EndpointClient = await loadEndpointClient()
const client = new EndpointClient(clientSocketPath)
await client.connect(200, 50)
client.assertMethod('pane.focus')
await client.callEndpoint('pane.focus', { pane_id: paneId })
await sleep(600)
client.sendPaneInput(paneId, [{ type: 'text', text: `${command}\r` }])
await sleep(600)
client.close()
console.log('sent', paneId, command)
