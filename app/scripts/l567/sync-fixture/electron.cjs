// LIFE-567 fix1 R1-01 — 리뷰어 fixture(codex-r1-raw/electron.cjs) 이식. 격리 Electron 창(show:false, backgroundThrottling:false)에서
// browser.js 를 모드별로 돌려 결과 JSON 을 쓴다. 사용(app/ 에서): ELECTRON_RUN_AS_NODE= <Electron> scripts/l567/sync-fixture/electron.cjs <out 폴더> <mode: r1|fix1>...
const fs = require('node:fs'); const path = require('node:path'); const { app, BrowserWindow } = require('electron')
const [out, ...modes] = process.argv.slice(2)
if (!out || modes.length === 0) { console.error('사용: electron.cjs <out> <mode>...'); process.exit(2) }
app.setPath('userData', path.join(out, 'ud')); app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const watchdog = setTimeout(() => { console.error('watchdog'); app.exit(1) }, 120000)
app.whenReady().then(async () => {
  console.log('electron-main-pid', process.pid)
  let code = 0
  // 창 하나를 모드마다 다시 싣는다 — 창을 닫으면 window-all-closed 로 앱이 내려가 다음 싣기가 ERR_FAILED 다
  const win = new BrowserWindow({ width: 1050, height: 650, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } })
  for (const mode of modes) {
    try {
      await win.loadFile(path.join(__dirname, 'fixture.html'))
      const src = fs.readFileSync(path.join(__dirname, 'browser.js'), 'utf8').replace('__MODE__', JSON.stringify(mode)).replace('__APP__', JSON.stringify(path.resolve(__dirname, '../../..')))
      const result = await win.webContents.executeJavaScript(src)
      fs.writeFileSync(path.join(out, `${mode}.json`), JSON.stringify(result, null, 1))
      console.log(JSON.stringify({ mode, metrics: app.getAppMetrics().map((x) => ({ pid: x.pid, type: x.type })), summary: result.summary }))
    } catch (error) { console.error(mode, error); code = 1 }
  }
  win.destroy()
  clearTimeout(watchdog); app.exit(code)
}).catch((error) => { console.error(error); app.exit(1) })
