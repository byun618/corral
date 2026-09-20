import {verifyFix} from './gui-fix-checks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const raw = process.env.CORRAL_VERIFY_RAW ? path.resolve(process.env.CORRAL_VERIFY_RAW) : path.resolve(app,'../specs/LIFE-391-command-palette-cli/raw/first-release/codex/gui')
fs.mkdirSync(raw,{recursive:true})
const root=fs.mkdtempSync('/tmp/c391-gui-'),data=path.join(root,'data'),repo=path.join(root,'fixture repository'),home=path.join(root,'herdr'),control=path.join(root,'control.sock'),session=`life373-first-${process.pid}`
for(const dir of[data,repo,home])fs.mkdirSync(dir,{mode:0o700})
fs.writeFileSync(path.join(home,'config.toml'),'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
const bin=path.join(root,'fixture-bin');fs.mkdirSync(bin);
for(const kind of ['claude','codex','grok'])fs.writeFileSync(path.join(bin,kind),`#!/bin/sh\nprintf 'fixture-only:${kind} pid=%s tty=%s\\n' "$$" "$(tty)" > '${root}/${kind}.started'\nprintf 'ISOLATED EXECUTABLE FIXTURE ${kind}\\n'\nexec /bin/sleep 180\n`,{mode:0o755})
const env={...process.env,PATH:bin+':'+process.env.PATH,CORRAL_USER_DATA:data,HERDR_CONFIG_PATH:path.join(home,'config.toml'),XDG_CONFIG_HOME:home,CORRAL_SESSION:session,CORRAL_CONTROL_SOCKET:control,CORRAL_SHOT_DIR:raw,CORRAL_REGISTRY:path.join(data,'repos.json'),SHELL:'/bin/sh'}
for(const key of ['CORRAL_CLI_SOCKET','CORRAL_RUNTIME_SOCKET','CORRAL_BACKEND_SOCKET','ELECTRON_RUN_AS_NODE'])delete env[key]
const commands=[],observations=[],inputs=[];let desktopPid,backend,serving,ws
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(fn,label='condition'){const end=Date.now()+15000;let last;while(Date.now()<end){try{const x=await fn();if(x)return x}catch(e){last=String(e)}await pause(80)}throw Error(`${label} timeout ${last??''}`)}
const run=(exe,args,expected=0)=>{const r=spawnSync(exe,args,{env,encoding:'utf8',timeout:30000});commands.push({exe,args,exit:r.status,stdout:r.stdout,stderr:r.stderr});assert.equal(r.status,expected,JSON.stringify(commands.at(-1)));return r.stdout}
const cli=args=>JSON.parse(run(process.execPath,[path.join(app,'cli/corral.mjs'),...args,'--json']))
function rpc(socketPath,req){return new Promise((resolve,reject)=>{const s=net.createConnection(socketPath);let buf='';const timer=setTimeout(()=>{s.destroy();reject(Error('rpc timeout'))},10000);s.on('error',e=>{clearTimeout(timer);reject(e)});s.on('connect',()=>s.write(JSON.stringify(req)+'\n'));s.on('data',chunk=>{buf+=chunk;if(buf.includes('\n')){clearTimeout(timer);s.destroy();resolve(JSON.parse(buf.split('\n')[0]))}})})}
const send=async req=>{const r=await rpc(control,req);assert(r.ok,JSON.stringify({req,r}));if(req.cmd!=='eval'&&req.cmd!=='state')inputs.push({req,r});return r}
const ev=async code=>(await send({cmd:'eval',code})).result
const key=async(keyCode,modifiers=[],type)=>{await send({cmd:'key',keyCode,modifiers,...type?{type}:{}});await pause(150)}
const click=async selector=>{const r=await send({cmd:'click',selector});assert(r.hit);await pause(150)}
const count=sel=>ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
const shot=name=>send({cmd:'shot',name})
const search=async text=>{if(await ev('document.querySelector("[role=combobox]").value')){await key('Escape');await click('[data-palette-open]')}await click('[role=combobox]');await key('Right');await send({cmd:'type',text});await until(async()=>await ev('document.querySelector("[role=combobox]").value')===text,'search value')}
const action=async id=>{await click('[data-palette-open]');await search(id);await click(`[data-palette-entry="${id}"]`);await until(async()=>await count('[data-command-palette]')===0,'palette close')}
const hs=path.join(home,'herdr/sessions',session,'herdr.sock')
const backendRpc=async(method,params={})=>{const r=await rpc(hs,{id:'fixture',method,params});assert(!r.error,JSON.stringify(r));return r.result}
let cdp
try{
 run('git',['init','-b','main',repo]);run('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture'])
 const fd=fs.openSync(path.join(raw,'backend.log'),'w');backend=spawn('herdr',['--session',session,'server'],{env,stdio:['ignore',fd,fd]});fs.closeSync(fd)
 await until(()=>fs.existsSync(hs),'backend socket');env.CORRAL_BACKEND_SOCKET=hs
 const created=await backendRpc('workspace.create',{cwd:repo,focus:false});observations.push({fixtureCreated:created,backendPid:backend.pid})
 const before=await backendRpc('pane.list');const firstPane=before.panes[0].pane_id
 const processBefore=await backendRpc('pane.process_info',{pane_id:firstPane})
 const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r))
 const wrapper=path.join(root,'electron');const quote=s=>"'"+s.replaceAll("'","'\\''")+"'"
 fs.writeFileSync(wrapper,`#!/bin/sh\nexec ${quote(path.join(app,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))} --remote-debugging-port=${port} "$@"\n`,{mode:0o755});env.CORRAL_ELECTRON=wrapper
 serving=spawn(process.execPath,[path.join(app,'cli/corral.mjs'),'serve','--json'],{env});let serveOut='';serving.stdout.on('data',b=>serveOut+=b)
 await until(()=>serveOut.includes('\n'),'serve ready');const serveStatus=JSON.parse(serveOut).result
 assert.equal(serveStatus.ui.available,false);assert.equal(serveStatus.backend.session,session)
 // Cross-profile refusal while a real backend and shell are alive: no session handoff effect.
 const foreign=path.join(root,'foreign');fs.mkdirSync(foreign,{mode:0o700})
 for(const instance of [[],['--instance',serveStatus.runtime.runtimeId]]){
   const args=['open','--socket',serveStatus.target.socket,...instance,'--timeout-ms','1500','--json']
   const result=spawnSync(process.execPath,[path.join(app,'cli/corral.mjs'),...args],{env:{...env,CORRAL_USER_DATA:foreign},encoding:'utf8',timeout:5000})
   const response=JSON.parse(result.stdout);assert.equal(result.status,1);assert.equal(response.error.code,'profile_mismatch');assert.equal(response._meta.outcome,'not_started')
   const status=cli(['status']),current=await backendRpc('pane.process_info',{pane_id:firstPane})
   assert.equal(status.result.runtime.runtimeId,serveStatus.runtime.runtimeId);assert.equal(status.result.runtime.pid,serving.pid);assert.equal(current.process_info.shell_pid,processBefore.process_info.shell_pid);process.kill(backend.pid,0)
   assert(!fs.existsSync(path.join(foreign,'runtime/profile.json')))
   observations.push({crossProfileWithSession:{args,response,exit:result.status,stdout:result.stdout,stderr:result.stderr,status,backendPid:backend.pid,processBefore,processAfter:current}})
 }
 // New CLI deliberately lacks backend env: desktop restores the persisted profile binding.
 delete env.CORRAL_BACKEND_SOCKET;delete env.CORRAL_SESSION
 const opened=cli(['open']);desktopPid=opened.result.runtime.pid
 assert.equal(opened.result.ui.available,true);assert.equal(opened.result.runtime.runtimeId,serveStatus.runtime.runtimeId)
 await until(()=>serving.exitCode!==null,'headless exit')
 process.kill(backend.pid,0)
 await until(()=>fs.existsSync(control),'control socket');await until(async()=>(await send({cmd:'state'})).state?.link.phase==='live','GUI connected')
 const after=await backendRpc('pane.list'),processAfter=await backendRpc('pane.process_info',{pane_id:firstPane})
 assert.deepEqual(after.panes.map(p=>p.pane_id),before.panes.map(p=>p.pane_id));assert(Number.isInteger(processBefore.process_info.shell_pid));assert.equal(processAfter.process_info.shell_pid,processBefore.process_info.shell_pid);assert.deepEqual(after.panes.map(p=>p.terminal_id),before.panes.map(p=>p.terminal_id))
 observations.push({handoff:{serveStatus,opened:opened.result,backendPidBefore:backend.pid,backendPidAfter:backend.pid,before,after,processBefore,processAfter}})
 await send({cmd:'add-repo',root:repo});await until(async()=>(await send({cmd:'state'})).state.repos.some(r=>r.root===fs.realpathSync(repo)),'repo fixture')
 await until(async()=>await count('[data-term-pane-box]')>0,'terminal visible')
 await ev('window.__keys=[];document.addEventListener("keydown",e=>window.__keys.push({key:e.key,code:e.code,trusted:e.isTrusted}))');
 await click('[data-term-pane-box]');await key('K',['meta']);assert.equal(await ev('document.activeElement?.getAttribute("role")'),'combobox');await key('Escape');assert(await ev('!!document.activeElement?.closest("[data-term-pane-box]")'));await key('K',['meta'])
 const catalog=await ev('[...document.querySelectorAll("[data-palette-entry]")].map(e=>({id:e.dataset.paletteEntry,disabled:e.getAttribute("aria-disabled"),text:e.textContent}))');observations.push({catalog})
 for(const id of ['terminal.new:0','mru.open:0','mru.open:1','terminal.split:0','terminal.split:1','group.split:0','group.split:1','terminal.focus:0','terminal.focus:1','terminal.focus:2','terminal.focus:3','group.close:0','terminal.zoom:0','terminal.close:0','sidebar.toggle:0','agent.start.claude','agent.start.codex','agent.start.grok','repo.add'])assert(catalog.some(e=>e.id===id),id)
 assert.equal(catalog.find(e=>e.id==='group.split:0').disabled,'true')
 await search('group.split');await key('Enter');assert.equal(await count('[data-command-palette]'),1)
 await search('zzzznomatch');assert.equal(await count('[role=option]'),0);assert.match(await ev('document.querySelector("[role=status]").textContent'),/검색 결과/)
 await search('TERMINAL.NEW');assert.equal(await count('[data-palette-entry="terminal.new:0"]'),1)
 await search('tmnw');assert.equal(await count('[data-palette-entry="terminal.new:0"]'),1)
 await search('새');assert((await count('[role=option]'))>0)
 const panesBefore=(await backendRpc('pane.list')).panes.length
 for(const[k,m]of[['W',['meta']],['D',['meta']],['Tab',['control']]])await key(k,m)
 assert.equal((await backendRpc('pane.list')).panes.length,panesBefore);assert.equal(await count('[data-mru]'),0)
 await key('Control',[],'keyUp');for(let i=0;i<4;i++)await key('Tab',i%2?['shift']:[])
 assert.equal(await ev('document.activeElement?.getAttribute("role")'),'combobox')
 await shot('palette-default')
 await send({cmd:'resize-window',width:900,height:600});await pause(250)
 const geometry=await ev('(()=>{const r=document.querySelector("[data-command-palette]").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');assert(geometry.left>=0&&geometry.top>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height);observations.push({geometry})
 await shot('palette-900x600');await key('Escape');assert(await ev('document.activeElement?.matches("[data-palette-open]")'))
 await click('[data-palette-open]');assert.equal(await ev('document.querySelector("[role=combobox]").value'),'');await key('Down');await key('Up');await key('Escape')
 // Rebinding uses the actual settings dialog and key recording path.
 await click('[data-shortcuts-open]');await click('[data-record="palette.open"]');await key('P',['meta','shift']);await click('[data-save-binding]');await key('Escape')
 await key('K',['meta']);assert.equal(await count('[data-command-palette]'),0);await key('P',['meta','shift']);assert.equal(await count('[data-command-palette]'),1);await key('Escape')
 await click('[data-shortcuts-open]');await click('[data-reset="palette.open"]');await key('Escape')
 // Real Chromium composition events, not JS-dispatched keyboard events.
 const pages=await(await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find(p=>p.type==='page'&&p.title==='corral');assert(page)
 ws=new globalThis.WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const cb=pending.get(m.id);pending.delete(m.id);if(m.error)cb.reject(Error(JSON.stringify(m.error)));else cb.resolve(m.result)}};cdp=(method,params)=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});ws.send(JSON.stringify({id:next,method,params}))})
 const tabsBefore=await count('[data-main-tab]');await key('K',['meta']);await search('terminal.new')
 await ev('window.__imeEvents=[];for(const type of ["compositionstart","compositionupdate","compositionend","keydown"])document.querySelector("[role=combobox]").addEventListener(type,e=>window.__imeEvents.push({type:e.type,key:e.key,data:e.data,isComposing:e.isComposing,keyCode:e.keyCode,isTrusted:e.isTrusted}))')
 await cdp('Input.imeSetComposition',{text:'새',selectionStart:1,selectionEnd:1,replacementStart:0,replacementEnd:12});await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229})
 assert.equal(await count('[data-command-palette]'),1);const ime=await ev('window.__imeEvents');assert(ime.some(e=>e.type==='compositionstart'&&e.isTrusted));assert(ime.some(e=>e.type==='keydown'&&(e.isComposing||e.keyCode===229)));observations.push({ime,scope:'Chromium trusted IME; native OS input method not changed'})
 await shot('palette-ime');await cdp('Input.insertText',{text:'새'});await key('Enter');await until(async()=>await count('[data-main-tab]')===tabsBefore+1,'IME confirmed creates tab')
 await until(async()=>await ev('!!document.activeElement?.closest("[data-term-pane-box]")'),'action destination focus')
 const baseline=(await backendRpc('pane.list')).panes.length;await action('terminal.split:0');await until(async()=>(await backendRpc('pane.list')).panes.length===baseline+1,'palette split')
 await action('terminal.zoom:0');await action('terminal.zoom:0');await action('terminal.focus:0');await action('sidebar.toggle:0');await action('sidebar.toggle:0')
 await action('group.split:0');await until(async()=>await count('[data-tab-group]')>=2,'group split')
 await shot('groups-after-palette')
 await key('Tab',['control'],'keyDown');assert.equal(await count('[data-mru]'),1);await key('Escape');await key('Control',[],'keyUp');assert.equal(await count('[data-mru]'),0)
 await key('Tab',['control'],'keyDown');await key('Control',[],'keyUp');assert.equal(await count('[data-mru]'),0)
 // Rename must own all keys until it closes.
 const tab=await ev('document.querySelector("[data-main-tab]").dataset.mainTab');await send({cmd:'dblclick',selector:`[data-main-tab="${tab}"]`});await until(async()=>await count('.main-tab-rename.is-editing')===1,'rename')
 for(const[k,m]of[['K',['meta']],['D',['meta']],['Tab',['control']]])await key(k,m)
 assert.equal(await count('[data-command-palette]'),0);assert.equal(await count('[data-mru]'),0);await key('Control',[],'keyUp');await key('Escape')
 // Modal entry through the palette and its guard, without launching agents.
 await action('repo.add');assert.equal(await count('[data-add-repo-modal]'),1);await key('K',['meta']);assert.equal(await count('[data-command-palette]'),0);await key('Escape')
 // Busy shell close uses the existing destructive confirmation.
 await click('[data-term-pane-box].is-selected');await send({cmd:'type',text:'sleep 60\n'});await pause(400);await action('terminal.close:0');await until(async()=>await count('[data-close-confirm-cancel]')===1,'close confirmation');await shot('close-confirmation');await key('Escape');assert.equal(await count('[data-close-confirm-cancel]'),0)
 await key('C',['control'])
 // Worktree modal shares the existing lifecycle, including visible validation failure.
 await action('worktree.create:'+fs.realpathSync(repo));await click('[data-worktree-create-submit]');assert.match(await ev('document.querySelector("[data-worktree-create-note]").textContent'),/branch/)
 await click('[data-worktree-branch-input]');await send({cmd:'type',text:'palette-fixture'});await click('[data-worktree-create-submit]');await until(async()=>await count('[data-create-worktree-modal]')===0,'worktree created')
 const linked=fs.realpathSync(repo)+'/.claude/worktrees/palette-fixture';assert(fs.existsSync(linked));observations.push({worktree:run('git',['-C',repo,'worktree','list','--porcelain'])})
 await action('repo.select:'+fs.realpathSync(repo));await until(async()=>await ev('document.querySelector("[data-term-pane-box].is-selected")?.dataset.termPaneBox?.startsWith("w1:")'),'primary worktree destination')
 await action('worktree.open:'+linked);await until(async()=>await ev('document.querySelector("[data-term-pane-box].is-selected")?.dataset.termPaneBox?.startsWith("w2:")'),'linked worktree destination')
 observations.push({worktreeSwitchDestination:await ev('document.querySelector("[data-term-pane-box].is-selected")?.dataset.termPaneBox')})
 await action('repo.select:'+fs.realpathSync(repo));await until(async()=>await ev('document.querySelector("[data-term-pane-box].is-selected")?.dataset.termPaneBox?.startsWith("w1:")'),'repo destination')
 const memory=cli(['diagnostics','memory']).result;assert(memory.app.renderer.memory>0);assert(memory.scope.excludes.includes('backend'));observations.push({memory,finalState:(await send({cmd:'state'})).state})
 const reopened=cli(['open']);assert.equal(reopened.result.runtime.pid,desktopPid)
 for(const mode of ['hide','minimize']){
   await send({cmd:'window-visibility',action:mode});await pause(300)
   const before=await send({cmd:'window-visibility',action:'read'});assert(mode==='hide'?!before.visible:before.minimized)
   const statusBefore=cli(['status']);const opened=cli(['open','--timeout-ms','3000']);assert.equal(opened.result.runtime.pid,desktopPid);assert.equal(opened.result.runtime.runtimeId,serveStatus.runtime.runtimeId)
   const after=await send({cmd:'window-visibility',action:'read'});assert(after.visible&&!after.minimized);observations.push({windowOpen:{mode,before,statusBefore,opened,after}})
 }
 // Duplicate long labels remain distinguishable by full tab/pane hierarchy.
 const state=(await send({cmd:'state'})).state, tabs=state.repos.flatMap(r=>r.worktrees.flatMap(w=>w.workspace?.tabs??[]));const longLabel='같은 긴 탭 제목 '+ 'abcdefghij'.repeat(18)
 for(const t of tabs.slice(0,2))await backendRpc('tab.rename',{tab_id:t.tabId,label:longLabel})
 await until(async()=>{const s=(await send({cmd:'state'})).state;return JSON.stringify(s).includes(longLabel)},'long label sync')
 await click('[data-palette-open]');await search(longLabel)
 const details=await ev(`[...document.querySelectorAll("[data-palette-entry]")].map(e=>({id:e.dataset.paletteEntry,title:e.title,scroll:e.scrollWidth,width:e.clientWidth,label:[...e.querySelectorAll('strong,small')].map(n=>({text:n.textContent,width:n.clientWidth,scroll:n.scrollWidth,overflow:getComputedStyle(n).overflow,textOverflow:getComputedStyle(n).textOverflow,whiteSpace:getComputedStyle(n).whiteSpace}))}))`);assert(details.length>=2);assert(new Set(details.map(r=>r.title)).size>=2);assert(details.every(r=>r.title.includes(longLabel)&&r.scroll<=r.width));assert(details.every(r=>r.label[0].scroll>r.label[0].width&&r.label[0].textOverflow==='ellipsis'&&r.label[0].overflow==='hidden'&&r.label[0].whiteSpace==='nowrap'));observations.push({longLabels:details});await shot('palette-long-labels');await key('Escape')
 // Remove a searched target externally; the open palette must lose that stale action.
 const doomed=tabs.at(-1);assert(doomed)
 const target='pane.switch:'+doomed.panes[0].paneId;await click('[data-palette-open]');await search(target);assert.equal(await count('[data-palette-entry="'+target+'"]'),1)
 await backendRpc('tab.close',{tab_id:doomed.tabId});await until(async()=>await count('[data-palette-entry="'+target+'"]')===0,'stale action removed');await key('Enter');assert.equal(await count('[data-command-palette]'),1);await key('Escape')
 await verifyFix({ev,key,click,search,action,count,until,backendRpc,send,observations,root,repo,workspaceId:created.workspace.workspace_id,bin})
 observations.push({staleTargetRemoved:target,allGuiChecksPassed:true})
}finally{
 try { if(fs.existsSync(path.join(data,'corral.ndjson')))fs.copyFileSync(path.join(data,'corral.ndjson'),path.join(raw,'main.ndjson')) } catch { /* Log may not exist after early launch failure. */ }
 ws?.close()
 if(desktopPid){try{process.kill(desktopPid,'SIGTERM')}catch{/* already stopped */}}
 if(serving?.exitCode===null)serving.kill('SIGTERM')
 if(backend){env.CORRAL_SESSION=session;env.CORRAL_BACKEND_SOCKET=hs;run('herdr',['--session',session,'server','stop']);if(backend.exitCode===null)backend.kill('SIGTERM')}
 fs.writeFileSync(path.join(raw,'evidence.json'),JSON.stringify({root,data,repo,session,desktopPid,commands,observations,inputs},null,2))
}
console.log('GUI first release checks passed')
