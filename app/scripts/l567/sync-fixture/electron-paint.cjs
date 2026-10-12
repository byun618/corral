// LIFE-567 fix2 R2-01 — paint-matrix.js 러너(리뷰어 codex-r2-raw/electron.cjs 와 같은 창: 1700×1400, show:false, backgroundThrottling:false).
// 사용(app/ 에서): env -u ELECTRON_RUN_AS_NODE <Electron> scripts/l567/sync-fixture/electron-paint.cjs <out> <set> <mode>...
// 수집기다 — exit 0 은 수집 성공일 뿐 판정이 아니다. 판정은 결과 summary(other·공백 회차·clears·new 회차)를 읽는다.
const fs = require('node:fs'); const path = require('node:path'); const { app, BrowserWindow } = require('electron')
const [out, set, ...modes] = process.argv.slice(2)
if (!out || !set || modes.length === 0) { console.error('사용: electron-paint.cjs <out> <set> <mode>...'); process.exit(2) }
app.setPath('userData', path.join(out, 'ud')); app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const watchdog = setTimeout(() => { console.error('watchdog'); app.exit(1) }, 300000)
app.whenReady().then(async () => {
  console.log('electron-main-pid', process.pid); let code = 0
  const win = new BrowserWindow({ width: 1700, height: 1400, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } })
  for (const mode of modes) {
    try {
      await win.loadFile(path.join(__dirname, 'fixture.html'))
      const src = fs.readFileSync(path.join(__dirname, 'paint-matrix.js'), 'utf8').replaceAll('__MODE__', JSON.stringify(mode)).replaceAll('__SET__', JSON.stringify(set)).replaceAll('__APP__', JSON.stringify(path.resolve(__dirname, '../../..')))
      const result = await win.webContents.executeJavaScript(src)
      fs.writeFileSync(path.join(out, `${set}-${mode}.json`), JSON.stringify(result, null, 1))
      console.log(JSON.stringify({ set, mode, summary: result.summary, metrics: app.getAppMetrics().map((x) => ({ pid: x.pid, type: x.type })) }))
    } catch (error) { console.error(set, mode, error); code = 1 }
  }
  clearTimeout(watchdog); win.destroy(); app.exit(code)
}).catch((error) => { console.error(error); app.exit(1) })
