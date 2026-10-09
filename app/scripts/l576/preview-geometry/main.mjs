// R3-A 사본 기하 측정 — `electron main.mjs <outDir>`. 숨긴 창에 제품 Sidebar·useSidebarReorder·CSS 를 띄우고 DOM mousedown/move 로 c 를 든다.
// 손자 없음/있음 두 경우의 원래 카드·사본 틀·복제 행 사각형을 <outDir>/geometry.json 에 쓰고, 손자 없음에서 복제 행 폭·왼쪽이 틀과 같지 않으면 exit 1.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
const out = path.resolve(process.argv[process.argv.length - 1])
app.setPath('userData', path.join(out, 'userdata'))
app.commandLine.appendSwitch('disable-background-networking')
app.dock?.hide()
console.log('PID', process.pid)
const measure = `(async()=>{
 const results=[];
 const shape=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,marginLeft:getComputedStyle(el).marginLeft}};
 for(const grandchild of [false,true]){
  await window.showCase(grandchild);
  const source=document.querySelector('[data-worktree="/c"]');const before=shape(source);
  const surface=source.querySelector('[data-worktree-card-parent-content]');
  const x=before.left+35,y=before.top+20;
  surface.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y,button:0,buttons:1}));
  document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x+10,clientY:y+10,button:0,buttons:1}));
  await new Promise(r=>setTimeout(r,50));
  const preview=document.querySelector('[data-sidebar-drag-preview]');
  results.push({grandchild,before,preview:preview?shape(preview):null,clones:preview?[...preview.children].map(shape):[]});
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x+10,clientY:y+10,button:0}));
  await new Promise(r=>setTimeout(r,20));
 }
 return results;
})()`
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 750, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } })
  win.webContents.on('console-message', (_, details) => console.log('RENDERER', details.message))
  try {
    await win.loadFile(path.join(out, 'browser.html'))
    const result = await win.webContents.executeJavaScript(measure)
    fs.writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    const scale = 1.015
    const checks = result.map((entry) => {
      const first = entry.clones[0]
      const ok = entry.preview !== null && first !== undefined &&
        Math.abs(first.width / scale - entry.before.width) < 0.5 &&
        (entry.grandchild || Math.abs(first.left - entry.preview.left) < 0.5)
      return { grandchild: entry.grandchild, ok, cloneWidthUnscaled: first ? first.width / scale : null, sourceWidth: entry.before.width, cloneLeftMinusFrame: first && entry.preview ? first.left - entry.preview.left : null }
    })
    console.log('CHECKS', JSON.stringify(checks))
    if (!checks.every((check) => check.ok)) process.exitCode = 1
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win.destroy()
    // app.quit() 은 종료코드 0 으로 끝난다 — 판정 실패를 호출자에게 넘기려고 exit 로 끝낸다.
    app.exit(process.exitCode ?? 0)
  }
})
setTimeout(() => { console.error('fixture timeout'); app.exit(2) }, 20000).unref()
