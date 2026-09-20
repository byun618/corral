import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const raw = path.resolve(app, '../specs/LIFE-391-command-palette-cli/raw/first-release/codex/cli')
fs.mkdirSync(raw, { recursive: true })
const root = fs.mkdtempSync('/tmp/c391-cli-'), data = path.join(root, 'data')
const env = { ...process.env, CORRAL_USER_DATA: data }
for (const key of ['CORRAL_CLI_SOCKET','CORRAL_RUNTIME_SOCKET','CORRAL_BACKEND_SOCKET','CORRAL_SESSION','CORRAL_CONTEXT_FILE']) delete env[key]
const calls = [], observations = [], children = [], servers = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const run = (args, expected = 0, extra = {}, input = '') => {
 const r = spawnSync(process.execPath, [path.join(app,'cli/corral.mjs'),...args], { env: {...env,...extra}, encoding:'utf8', input, timeout:15000 })
 calls.push({argv:args,stdin:input,exit:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,env:extra})
 assert.equal(r.status,expected,JSON.stringify(calls.at(-1)))
 return args.includes('--json') ? JSON.parse(r.stdout) : r.stdout
}
async function until(fn) { const end=Date.now()+10000; while(Date.now()<end){if(await fn())return;await pause(30)}throw new Error('condition timeout') }
async function serve(extra={}) {
 const p=spawn(process.execPath,[path.join(app,'cli/corral.mjs'),'serve','--json'],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});children.push(p)
 let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b)
 await until(()=>stdout.includes('\n')||p.exitCode!==null)
 calls.push({argv:['serve','--json'],pid:p.pid,stdout,stderr,env:extra})
 const ready=JSON.parse(stdout.split('\n')[0]);assert(ready.ok,stdout);return {p,ready}
}
async function stop(p,signal='SIGTERM'){p.kill(signal);await until(()=>p.exitCode!==null||p.signalCode!==null)}
function rawRpc(socket,line){return new Promise((resolve,reject)=>{const s=net.createConnection(socket);let text='';const t=setTimeout(()=>{s.destroy();reject(Error('raw timeout'))},2000);s.on('connect',()=>s.write(line));s.on('data',b=>text+=b);s.on('error',reject);s.on('close',()=>{clearTimeout(t);resolve(text)})})}
try {
 const schema=run(['agent-context','--json']);assert.deepEqual(schema.commands.map(s=>s.command),['open','serve','status','agent-context','diagnostics memory'])
 assert.equal(run(['--help','--json']).commands.length,5)
 for(const args of [['terminal','list'],['browser','status'],['environment','list'],['repo','add'],['status','--host','local'],['serve','--port','0'],['status','--timeout-ms','0'],['status','--json','--json'],['status','extra']])run([...args,'--json'],1)
 run(['terminal','list','--socket',path.join(root,'none.sock'),'--json'],1,{CORRAL_CLI_SOCKET:path.join(root,'old.sock')})
 run(['status','--json'],1)
 run(['diagnostics','memory','--json'],1)
 run(['status','--socket','relative','--json'],1)
 let {p,ready}=await serve();const initial=ready.result
 run(['serve','--json'],1)
 assert.equal(run(['status','--instance','wrong','--json'],1).error.code,'identity_mismatch')
 assert.equal(run(['status','--json'],0,{},'ignored stdin\n').result.runtime.runtimeId,initial.runtime.runtimeId)
 const release=path.join(root,'release');fs.mkdirSync(path.join(release,'cli'),{recursive:true});fs.mkdirSync(path.join(release,'out/runtime'),{recursive:true});fs.copyFileSync(path.join(app,'cli/corral.mjs'),path.join(release,'cli/corral.mjs'));fs.copyFileSync(path.join(app,'out/runtime/cli.mjs'),path.join(release,'out/runtime/cli.mjs'))
 const relocated=spawnSync(process.execPath,[path.join(release,'cli/corral.mjs'),'status','--instance',initial.runtime.runtimeId,'--json'],{env,encoding:'utf8'});assert.equal(relocated.status,0);assert.equal(JSON.parse(relocated.stdout).result.runtime.pid,p.pid);observations.push({relocated:{path:release,stdout:relocated.stdout,stderr:relocated.stderr,exit:relocated.status}})
 const memory=run(['diagnostics','memory','--json']).result
 const ps=spawnSync('ps',['-p',String(p.pid),'-o','pid=,rss='],{encoding:'utf8'});observations.push({memory,oracle:ps.stdout})
 const rss=Number(ps.stdout.trim().split(/\s+/)[1])*1024;assert(memory.app.main.memory>rss*.5&&memory.app.main.memory<rss*2)
 const socket=path.join(data,'runtime/rpc.sock')
 const expired=await rawRpc(socket,JSON.stringify({version:1,id:'deadline',timeoutMs:1,invocation:{command:'diagnostics memory',flags:{},args:[],cwd:root}})+'\n');assert.equal(JSON.parse(expired).ok,false);observations.push({serverDeadline:JSON.parse(expired)})
 const malformed=await rawRpc(socket,'{\n');assert.equal(JSON.parse(malformed).ok,false)
 const oversized=await rawRpc(socket,'x'.repeat(512*1024+1));assert.equal(oversized,'')
 observations.push({malformed,oversizedBytes:512*1024+1,recovery:run(['status','--json'])})
 const oldInode=fs.statSync(socket).ino;await stop(p,'SIGKILL')
 const contenders=await Promise.all(Array.from({length:4},async()=>{
   const cp=spawn(process.execPath,[path.join(app,'cli/corral.mjs'),'serve','--json'],{env});children.push(cp);let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b)
   await until(()=>stdout.includes('\n')||cp.exitCode!==null);const response=JSON.parse(stdout.split('\n')[0]);calls.push({argv:['serve','--json'],race:true,pid:cp.pid,stdout,stderr});return {p:cp,ready:response}
 }))
 assert.equal(contenders.filter(c=>c.ready.ok).length,1);({p,ready}=contenders.find(c=>c.ready.ok));assert.equal(ready.result.runtime.runtimeId,initial.runtime.runtimeId);assert.notEqual(ready.result.runtime.instanceId,initial.runtime.instanceId)
 observations.push({initial,restarted:ready.result,oldInode,newInode:fs.statSync(socket).ino})
 await stop(p);run(['status','--json'],1)
 const mock=path.join(root,'mock.sock'),clients=new Set();let writes=0
 const server=net.createServer(s=>{clients.add(s);s.on('data',()=>writes++);s.on('close',()=>clients.delete(s))});servers.push({server,clients})
 await new Promise(resolve=>server.listen(mock,resolve));fs.chmodSync(mock,0o600)
 // Async CLI process permits this independent mock to accept and consume requests.
 async function mockCall(cancel=false){return await new Promise(resolve=>{const cp=spawn(process.execPath,[path.join(app,'cli/corral.mjs'),'status','--socket',mock,'--timeout-ms',cancel?'5000':'80','--json'],{env});children.push(cp);let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);if(cancel)setTimeout(()=>cp.kill('SIGINT'),250);cp.on('close',exit=>{calls.push({mock:true,cancel,exit,stdout,stderr});resolve({exit,result:JSON.parse(stdout)})})})}
 assert.equal((await mockCall()).result.error.code,'outcome_unknown');assert.equal((await mockCall(true)).result.error.code,'request_cancelled');assert.equal(writes,2)
 fs.chmodSync(mock,0o666);assert.equal(run(['status','--socket',mock,'--json'],1).error.code,'unsafe_permissions');fs.chmodSync(mock,0o600)
 const before=fs.statSync(mock).ino;run(['serve','--socket',mock,'--json'],1);assert.equal(fs.statSync(mock).ino,before)
 const badbin=path.join(root,'bin');fs.mkdirSync(badbin);fs.writeFileSync(path.join(badbin,'ps'),'#!/bin/sh\nexit 7\n',{mode:0o755})
 ;({p}=await serve({PATH:badbin}));assert.equal(run(['diagnostics','memory','--json'],1).error.code,'operation_failed');await stop(p)
 observations.push({responseLossRequests:writes,measurementFailure:true,foreignSocketPreserved:true})
} finally {
 for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGTERM')
 for(const {server,clients}of servers){for(const s of clients)s.destroy();server.close()}
 fs.writeFileSync(path.join(raw,'evidence.json'),JSON.stringify({root,node:process.version,calls,observations},null,2))
}
console.log('CLI first release checks passed')
