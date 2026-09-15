// LIFE-373 스파이크 — throwaway Electron 셸. 앱 본체(app/src)와 무관하다.
// 시나리오 하나당 프로세스 하나 (GC/JIT 이월 없음). 결과 JSON 을 쓰고 스스로 종료한다.
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const configPath = process.env.L373_CONFIG
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

// 창이 화면 밖으로 나가면 Chromium 이 페인트를 건너뛴다 — 작업영역 안으로 가둔다.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

app.whenReady().then(() => {
  const work = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(config.window.width, work.width)
  const height = Math.min(config.window.height, work.height)
  const win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: true,
    backgroundColor: '#141718',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      devTools: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 렌더러 프로세스는 로드가 끝나야 붙는다 — 그 전에 부르면 0 이 나온다 (smoke 에서 확인).
  win.webContents.once('did-finish-load', () => {
    process.stdout.write(`L373 pid main=${process.pid} renderer=${win.webContents.getOSProcessId()}\n`)
    process.stdout.write(`L373 window ${width}x${height} scaleFactor=${screen.getPrimaryDisplay().scaleFactor}\n`)
  })

  ipcMain.on('l373-mark', (_event, mark) => {
    process.stdout.write(`L373 mark ${mark} ${Date.now()}\n`)
    // 가장 바깥 오라클 — 실제 픽셀. 측정창 안에서 3장 찍어 해시를 비교한다.
    // DOM 변경(MutationObserver)이 화면까지 갔는지의 독립 확인 (관문 ②).
    if (mark === 'measure_start' && config.capture === true) {
      const shots = path.join(path.dirname(config.out), '..', 'shots')
      fs.mkdirSync(shots, { recursive: true })
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          win.webContents
            .capturePage()
            .then((image) => {
              const png = image.toPNG()
              const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16)
              const file = path.join(shots, `${config.name}-${i}.png`)
              fs.writeFileSync(file, png)
              process.stdout.write(`L373 shot ${i} ${hash} ${png.length} ${file}\n`)
            })
            .catch((error) => process.stdout.write(`L373 shot ${i} failed ${String(error)}\n`))
        }, 1000 + i * 1200)
      }
    }
  })
  ipcMain.on('l373-result', (_event, result) => {
    const metrics = app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpuPercent: m.cpu?.percentCPUUsage ?? null,
      // Electron 의 memory 는 플랫폼마다 비어 있다 — ps 쪽이 권위, 이건 참고값.
      memory: m.memory ?? null,
    }))
    fs.mkdirSync(path.dirname(config.out), { recursive: true })
    fs.writeFileSync(config.out, JSON.stringify({ ...result, appMetrics: metrics }, null, 2) + '\n')
    process.stdout.write(`L373 done ${config.out}\n`)
    setTimeout(() => app.exit(0), 900) // 드라이버의 ps 샘플러가 끝점을 잡을 틈
  })
  ipcMain.on('l373-fail', (_event, message) => {
    process.stderr.write(`L373 fail ${message}\n`)
    app.exit(3)
  })

  win.loadFile(path.join(__dirname, 'index.html'))
})
