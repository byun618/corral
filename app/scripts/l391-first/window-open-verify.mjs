import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
const app=path.resolve(process.env.CORRAL_VERIFY_APP),raw=path.resolve(process.env.CORRAL_VERIFY_RAW)
fs.mkdirSync(raw,{recursive:true})
const root=fs.mkdtempSync('/tmp/c391-window-'),data=path.join(root,'data'),socket=path.join(root,'control.sock')
const env={...process.env,CORRAL_USER_DATA:data,CORRAL_CONTROL_SOCKET:socket,CORRAL_BACKEND_SOCKET:path.join(root,'no-backend.sock'),CORRAL_SESSION:'isolated-window-fixture'}
for(const k of ['CORRAL_RUNTIME_SOCKET','CORRAL_CLI_SOCKET','CORRAL_ELECTRON','ELECTRON_RUN_AS_NODE'])delete env[k]
const pause=ms=>new Promise(r=>setTimeout(r,ms)),observations=[]
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const cli=args=>{const r=spawnSync(process.execPath,[path.join(app,'cli/corral.mjs'),...args,'--json'],{env,encoding:'utf8',timeout:12000});return {args,exit:r.status,stdout:r.stdout,stderr:r.stderr,response:JSON.parse(r.stdout)}}
const control=action=>new Promise((resolve,reject)=>{const s=net.createConnection(socket);let b='';s.on('connect',()=>s.write(JSON.stringify({cmd:'window-visibility',action})+'\n'));s.on('error',reject);s.on('data',c=>{b+=c;if(b.includes('\n')){s.destroy();resolve(JSON.parse(b))}})})
let child
try{
 const fd=fs.openSync(path.join(raw,'desktop.log'),'w');child=spawn(path.join(app,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[app],{env,stdio:['ignore',fd,fd]});fs.closeSync(fd)
 for(let i=0;i<200&&!fs.existsSync(socket);i++)await pause(50)
 assert(fs.existsSync(socket));await pause(300)
 const initial=cli(['open','--timeout-ms','1500']);assert.equal(initial.exit,0)
 for(const mode of ['hide','minimize']){
   // Restore directly between cases so each starts visible, independent of CLI behavior.
   if(mode==='minimize'){child.kill('SIGTERM');await new Promise(r=>child.on('close',r));fs.rmSync(socket,{force:true});const fd=fs.openSync(path.join(raw,'desktop.log'),'a');child=spawn(path.join(app,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[app],{env,stdio:['ignore',fd,fd]});fs.closeSync(fd);for(let i=0;i<200&&!fs.existsSync(socket);i++)await pause(50);await pause(300)}
   await control(mode);await pause(300);const before=await control('read');assert(mode==='hide'?!before.visible:before.minimized)
   const result=cli(['open','--timeout-ms','700']),after=await control('read')
   if(process.env.CORRAL_EXPECT_HIDDEN_FAILURE==='1'){assert.equal(result.exit,1);assert(!after.visible||after.minimized)}else{assert.equal(result.exit,0);assert(after.visible&&!after.minimized)}
   observations.push({mode,before,result,after})
 }
}finally{
 if(child&&alive(child.pid))child.kill('SIGTERM');if(child)for(let i=0;i<200&&alive(child.pid);i++)await pause(30)
 fs.writeFileSync(path.join(raw,'evidence.json'),JSON.stringify({app,root,expectFailure:process.env.CORRAL_EXPECT_HIDDEN_FAILURE==='1',observations,cleanup:{lastPid:child?.pid,stopped:!child||!alive(child.pid)}},null,2));fs.rmSync(root,{recursive:true,force:true})
}
