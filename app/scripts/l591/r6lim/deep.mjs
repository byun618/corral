// LIFE-591 최종 관문 「한계 확인」(R6-A dirty-stale-discard-repeat · R6-B reload-delayed-push) — 리뷰어 codex-r6-raw/deep.mjs 그대로 사본(import 경로만 ../lib.mjs). 판정 분모 아님.
/* eslint-disable -- 원본 사본(본문 그대로 — 고치지 않는다) */
// 사용(app/ 에서, iso.sh 안, --inspect=0·write-hook·KEEP_PAINTING): node scripts/l591/r6lim/deep.mjs --root {ROOT} --repo /tmp/l591g-t/repo --out <dir> --mode <dirty-stale-discard-repeat|reload-delayed-push>
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {helpers,ctl,until,sleep} from './helpers.mjs';
import {mainInspector} from './inspector.mjs';
const {values:v}=parseArgs({options:{root:{type:'string'},repo:{type:'string'},out:{type:'string'},mode:{type:'string'}}});
fs.mkdirSync(v.out,{recursive:true});
const h=helpers(v.root,v.repo), result={mode:v.mode};
const pid=+fs.readFileSync(v.root+'/app.pid','utf8');
const alive=()=>{try{process.kill(pid,0);return true}catch{return false}};
const socket=v.root+'/ud/runtime/rpc.sock',file=path.join(v.repo,'r1/edit.txt'),original=fs.readFileSync(file,'utf8');
const rows=()=>fs.readFileSync(v.root+'/ud/corral.ndjson','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
await h.init();await h.open('r1/edit.txt');await h.expose();
const mi=await mainInspector(v.root);
const state=async()=>({alive:alive(),...(await h.ed(`return {text:m?.getValue()??null,readOnly:e?.getOption(window.reviewMonaco.editor.EditorOption.readOnly),editors:window.reviewMonaco.editor.getEditors().length,models:window.reviewMonaco.editor.getModels().length,dirty:document.querySelector('[data-file-view]')?.dataset.fileDirty,tab:!!document.querySelector('[data-file-tab="r1/edit.txt"]')};`)),visible:(await ctl(v.root,{cmd:'window-visibility',action:'read'})).visible,runtimeSocket:fs.existsSync(socket),disk:fs.readFileSync(file,'utf8'),toast:await h.js(`[...document.querySelectorAll('[data-sonner-toast]')].map(e=>e.textContent)`)});
let rp=null;
try{
 if(v.mode.startsWith('dirty-stale')){
  const choice=v.mode.includes('discard')?'discard':'save';
  await h.type('UNSAVED-');await sleep(200);result.before=await state();
  await ctl(v.root,{cmd:'file-dialog-stub',answers:['cancel',choice]});
  const busy=h.js(`(()=>{const end=performance.now()+4300;while(performance.now()<end){}return true})()`);await sleep(100);
  await ctl(v.root,{cmd:'quit-entry',via:'quit'});
  await until(()=>rows().some(r=>r.tag==='quit.unresponsive_choice'),{timeoutMs:6000});
  result.atCancel={alive:alive(),runtimeSocket:fs.existsSync(socket)};
  await busy;await sleep(600);result.after=await state();
  result.typed=await h.ed("e.setPosition({lineNumber:1,column:1});e.trigger('keyboard','type',{text:'NEXT-'});return {text:e.getModel()?.getValue()??null,lines:document.querySelector('[data-file-editor] .view-lines')?.textContent??null};").catch(e=>({error:String(e)}));await sleep(150);result.afterType=await state();
  if(choice==='discard'){
   await h.open('r1/multi-b.txt').catch(e=>result.switchError=String(e));
   await h.open('r1/edit.txt');await h.expose();result.returned=await state();
  }
  await ctl(v.root,{cmd:'file-dialog-stub',answers:['discard']});
  mi.close();await ctl(v.root,{cmd:'quit-entry',via:'quit'});result.retryExit=await until(()=>!alive(),{timeoutMs:10000}).then(()=>true,()=>false);
 }else if(v.mode==='invoke-destroy'){
  await h.type('INVOKE-');await sleep(200);await ctl(v.root,{cmd:'file-dialog-stub',answers:['save']});
  result.instrumented=await mi.eval("globalThis.r6confirm=r5electron.ipcMain._invokeHandlers.get('corral:confirmQuit');r5electron.ipcMain.removeHandler('corral:confirmQuit');r5electron.ipcMain.handle('corral:confirmQuit',async(ev,gen)=>{const accepted=r6confirm(ev,gen);await new Promise(resolve=>setTimeout(resolve,700));return accepted});true");
  await ctl(v.root,{cmd:'quit-entry',via:'quit'});mi.close();result.exit=await until(()=>!alive(),{timeoutMs:10000}).then(()=>true,()=>false);
 }else if(v.mode==='ipc-shapes'){
  result.replies=await h.js(`(async()=>{const args=[undefined,null,'1',1.5,-1,0,Infinity,{},[]];const out=[];for(const arg of args){const accepted=await window.corral.confirmQuit(arg);const cancelled=await window.corral.quitCancelled(arg);window.corral.quitAck(arg);out.push({arg:String(arg),accepted,cancelled})}return out})()`);
  result.after=await state();
 }else if(v.mode==='clean-reload'){
  await ctl(v.root,{cmd:'file-dialog-stub',answers:Array(8).fill('cancel')});rp=await mi.eval('r5w.webContents.getOSProcessId()');process.kill(rp,'SIGSTOP');result.loading=await mi.eval('r5w.webContents.reload();r5w.webContents.isLoadingMainFrame()');await ctl(v.root,{cmd:'quit-entry',via:'quit'});await sleep(150);process.kill(rp,'SIGCONT');rp=null;mi.close();result.exit=await until(()=>!alive(),{timeoutMs:10000}).then(()=>true,()=>false);
 }else if(v.mode.startsWith('protocol-')){
  const stale=v.mode.includes('newgen'),cancel=v.mode.includes('cancel'),discard=v.mode.includes('discard');
  const choice=cancel?'cancel':discard?'discard':'save';
  await h.type('PROTOCOL-');await sleep(200);result.before=await state();
  await mi.eval(`globalThis.r6oldDialog=r5electron.ipcMain._invokeHandlers.get('corral:fileDialog');globalThis.r6asked=[];globalThis.r6release=null;r5electron.ipcMain.removeHandler('corral:fileDialog');r5electron.ipcMain.handle('corral:fileDialog',async(ev,request)=>{r6asked.push(request);await new Promise(resolve=>{r6release=resolve});return ${JSON.stringify(choice)}});true`);
  if(stale){
   await ctl(v.root,{cmd:'file-dialog-stub',answers:['cancel']});
   const busy=h.js(`(()=>{const end=performance.now()+4300;while(performance.now()<end){}return true})()`);await sleep(100);
   await ctl(v.root,{cmd:'quit-entry',via:'quit'});await until(()=>rows().some(r=>r.tag==='quit.unresponsive_choice'),{timeoutMs:6000});await busy;
  }else await ctl(v.root,{cmd:'quit-entry',via:'quit'});
  await until(()=>mi.eval('r6asked.length > 0'));
  result.overlap=[];
  for(const via of ['close','quit','close'])result.overlap.push(await ctl(v.root,{cmd:'quit-entry',via}));
  await sleep(100);result.pending=await state();result.prompts=await mi.eval('r6asked');
  await mi.eval('r6release();true');
  if(cancel){await mi.eval("r5electron.ipcMain.removeHandler('corral:fileDialog');r5electron.ipcMain.handle('corral:fileDialog',r6oldDialog);true");await sleep(300);result.after=await state();result.typed=await h.type('AFTER-');result.afterType=await state();}
  mi.close();
  if(cancel){await ctl(v.root,{cmd:'file-dialog-stub',answers:['discard']});await ctl(v.root,{cmd:'quit-entry',via:'quit'});}
  result.exit=await until(()=>!alive(),{timeoutMs:10000}).then(()=>true,()=>false);
 }else if(v.mode==='reload-delayed-push'){
  result.delayInstrumentation=await mi.eval(`globalThis.r6dirtyHandlers=r5electron.ipcMain.listeners('corral:dirtyFiles');globalThis.r6held=[];r5electron.ipcMain.removeAllListeners('corral:dirtyFiles');r5electron.ipcMain.on('corral:dirtyFiles',(ev,files)=>r6held.push({ev,files}));true`);
  await h.type('LATE-');await sleep(200);result.before=await state();
  await ctl(v.root,{cmd:'file-dialog-stub',answers:Array(12).fill('cancel')});
  rp=await mi.eval('r5w.webContents.getOSProcessId()');process.kill(rp,'SIGSTOP');
  result.loading=await mi.eval('r5w.webContents.reload();({loading:r5w.webContents.isLoadingMainFrame(),held:r6held.map(r=>r.files)})');
  result.quit=await ctl(v.root,{cmd:'quit-entry',via:'quit'});await sleep(150);
  result.early={visible:(await ctl(v.root,{cmd:'window-visibility',action:'read'})).visible,runtimeSocket:fs.existsSync(socket)};
  await mi.eval(`for(const item of r6held)for(const f of r6dirtyHandlers)f(item.ev,item.files);r5electron.ipcMain.removeAllListeners('corral:dirtyFiles');for(const f of r6dirtyHandlers)r5electron.ipcMain.on('corral:dirtyFiles',f);true`);
  process.kill(rp,'SIGCONT');rp=null;await sleep(700);
  result.after=await state().catch(e=>({error:String(e)}));
 }else if(v.mode.startsWith('reload-late')){
  await ctl(v.root,{cmd:'file-dialog-stub',answers:Array(12).fill('cancel')});
  await mi.eval(`globalThis.r6dirty=[];r5electron.ipcMain.on('corral:dirtyFiles',(ev,files)=>r6dirty.push({files,at:Date.now()}));globalThis.r6events=[];for(const n of ['did-start-loading','did-stop-loading','will-prevent-unload','did-finish-load'])r5w.webContents.on(n,()=>r6events.push({event:n,at:Date.now(),loading:r5w.webContents.isLoadingMainFrame()}));true`);
  result.before=await state();
  const busy=h.ed(`e.setPosition({lineNumber:1,column:1});e.trigger('keyboard','type',{text:'LATE-'});globalThis.r6edited=m.getValue();const end=performance.now()+700;while(performance.now()<end){}return globalThis.r6edited`);
  await sleep(100);
  if(v.mode.includes('stop')){rp=await mi.eval('r5w.webContents.getOSProcessId()');process.kill(rp,'SIGSTOP')}
  result.loading=await mi.eval(`r5w.webContents.reload();({loading:r5w.webContents.isLoadingMainFrame(),dirty:r6dirty,events:r6events})`);
  if(v.mode.includes('control'))result.controlChange=await mi.eval('globalThis.r6actualLoading=r5w.webContents.isLoadingMainFrame.bind(r5w.webContents);r5w.webContents.isLoadingMainFrame=()=>false;({actual:r6actualLoading(),forGate:r5w.webContents.isLoadingMainFrame()})');
  result.quit=await ctl(v.root,{cmd:'quit-entry',via:v.mode.includes('close')?'close':'quit'});
  await sleep(100);result.early={visible:(await ctl(v.root,{cmd:'window-visibility',action:'read'})).visible,runtimeSocket:fs.existsSync(socket)};
  if(rp){await sleep(900);process.kill(rp,'SIGCONT');rp=null}
  result.typing=await busy.catch(e=>({error:String(e)}));await sleep(1200);
  result.events=await mi.eval('r6events').catch(e=>({error:String(e)}));
  result.control=fs.existsSync(v.root+'/ctl/ctl.sock');
  if(result.control){await h.expose();result.after=await state().catch(e=>({error:String(e)}));}else{mi.close();await sleep(200);result.alive=alive()}
 }
 result.disk=fs.readFileSync(file,'utf8');
}catch(e){result.error=String(e);process.exitCode=1;}
finally{if(rp)try{process.kill(rp,'SIGCONT')}catch{};mi.close();result.log=rows().filter(r=>r.tag.startsWith('quit.')||r.tag==='file.dialog'||r.tag==='file.reload_confirm'||r.tag==='file.write'||r.tag==='renderer.console');fs.writeFileSync(v.out+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
