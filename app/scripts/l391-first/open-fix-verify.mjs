import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const raw=path.resolve(process.env.CORRAL_VERIFY_RAW??path.join(app,'../specs/LIFE-391-command-palette-cli/raw/first-release/fix1/open'))
fs.mkdirSync(raw,{recursive:true})
const root=fs.mkdtempSync('/tmp/c391-open-'),children=[],fixtures=[],calls=[],observations=[]
const env={...process.env};for(const k of ['CORRAL_RUNTIME_SOCKET','CORRAL_CLI_SOCKET','CORRAL_BACKEND_SOCKET','CORRAL_SESSION','CORRAL_ELECTRON'])delete env[k]
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await pause(30)}throw Error('timeout')}
function invoke(data,args,extra={}){
 const p=spawn(process.execPath,[path.join(app,'cli/corral.mjs'),...args,'--json'],{env:{...env,CORRAL_USER_DATA:data,...extra}});children.push(p);let stdout='',stderr=''
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b)
 const done=new Promise(resolve=>p.on('close',exit=>{const r={args,data,pid:p.pid,exit,stdout,stderr,result:stdout.trim()?JSON.parse(stdout.trim().split('\n')[0]):null};calls.push(r);resolve(r)}))
 return {p,done,ready:async()=>{await until(()=>stdout.includes('\n'));return JSON.parse(stdout.split('\n')[0])}}
}
async function serve(data){const c=invoke(data,['serve']);const s=await c.ready();assert(s.ok);return {...c,status:s.result}}
async function call(data,args,extra){return await invoke(data,args,extra).done}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'"
try{
 const a=path.join(root,'a'),b=path.join(root,'b'),A=await serve(a),B=await serve(b),socket=A.status.target.socket
 for(const instance of [[],['--instance',A.status.runtime.runtimeId]]){
   const result=await call(b,['open','--socket',socket,...instance,'--timeout-ms','1500']);assert.equal(result.exit,1);assert.equal(result.result.error.code,'profile_mismatch');assert.equal(result.result._meta.outcome,'not_started')
   const afterA=(await call(a,['status'])).result.result,afterB=(await call(b,['status'])).result.result
   assert.deepEqual(afterA,A.status);assert.deepEqual(afterB,B.status);assert(alive(A.p.pid)&&alive(B.p.pid));observations.push({crossProfile:{instance,beforeA:A.status,afterA,beforeB:B.status,afterB,result}})
 }
 const missing=await call(b,['open','--socket',path.join(root,'missing.sock')]);assert.equal(missing.result.error.code,'runtime_unavailable');assert.equal(missing.result._meta.outcome,'not_started')
 const fresh=await call(path.join(root,'fresh'),['open','--timeout-ms','1000'],{CORRAL_ELECTRON:path.join(root,'nonexistent')});assert.equal(fresh.result.error.code,'launch_failed');assert.equal(fresh.result._meta.outcome,'not_started');observations.push({freshLaunchFailure:fresh})
 for(const kind of ['launch-error','deadline','cancel','replacement']){
   const data=path.join(root,kind),prior=await serve(data),marker=path.join(root,kind+'.pid'),executable=path.join(root,kind+'.sh')
   if(kind!=='launch-error'){
     const driver=path.join(root,kind+'.mjs')
     fs.writeFileSync(driver,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));`+(kind==='replacement'?`const p=${JSON.stringify(path.join(data,'runtime/profile.json'))};const profile=JSON.parse(fs.readFileSync(p));profile.runtimeId='replacement-fixture';fs.writeFileSync(p,JSON.stringify(profile));const {runCli}=await import(${JSON.stringify(path.join(app,'out/runtime/cli.mjs'))});await runCli(['serve','--json']);`:`setInterval(()=>{},1000);`))
     fs.writeFileSync(executable,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)}\n`,{mode:0o755})
   }
   const c=invoke(data,['open','--timeout-ms',kind==='cancel'?'8000':'1000'],{CORRAL_ELECTRON:executable})
   if(kind!=='launch-error'){await until(()=>fs.existsSync(marker));fixtures.push(Number(fs.readFileSync(marker)));if(kind==='cancel')c.p.kill('SIGINT')}
   const result=await c.done;assert.equal(result.exit,1);assert.equal(result.result._meta.outcome,'unknown');if(kind==='replacement')assert.equal(result.result.error.code,'identity_mismatch');if(kind==='cancel')assert.equal(result.result.error.code,'request_cancelled')
   await prior.done;assert(!alive(prior.p.pid));observations.push({handoffFailure:{kind,original:prior.status,result,fixturePid:kind==='launch-error'?null:fixtures.at(-1),profile:JSON.parse(fs.readFileSync(path.join(data,'runtime/profile.json')))}})
 }
 observations.push({allOpenChecksPassed:true})
}finally{
 for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGTERM')
 for(const pid of fixtures)if(alive(pid))process.kill(pid,'SIGTERM')
 await until(()=>children.every(p=>p.exitCode!==null||p.signalCode!==null)&&fixtures.every(pid=>!alive(pid)))
 fs.writeFileSync(path.join(raw,'evidence.json'),JSON.stringify({root,node:process.version,calls,observations,cleanup:{pids:[...children.map(p=>p.pid),...fixtures],allStopped:true}},null,2))
 fs.rmSync(root,{recursive:true,force:true})
}
console.log('open fix checks passed')
