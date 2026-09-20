import fs from 'node:fs'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fixture,rpc,until} from './lib.mjs'
const f=await fixture('installed')
const installed=spawnSync('which',['herdr'],{encoding:'utf8'}).stdout.trim()
const snapshot=()=>{const stat=fs.statSync(installed);return {path:installed,realpath:fs.realpathSync(installed),sha256:createHash('sha256').update(fs.readFileSync(installed)).digest('hex'),mtime:stat.mtime.toISOString(),ctime:stat.ctime.toISOString(),inode:stat.ino,size:stat.size}}
try{
 const before=snapshot(),socket=f.socket.replace('/herdr-dev/','/herdr/'),env={...f.env,CORRAL_BACKEND_SOCKET:socket}
 f.start(installed,['--session',env.CORRAL_SESSION,'server'],env,'installed-private-backend')
 const read=method=>rpc(socket,{id:'installed-probe',method,params:{}})
 await until(()=>fs.existsSync(socket),'installed private socket');await f.serve(env)
 await f.cli(['repo','add','--path',f.repo],{env})
 await f.check('Q3-installed-binary-unchanged-unsupported',async()=>{
  const prior=await read('pane.list')
  const response=await f.cli(['terminal','create','--worktree',f.repo],{env,fail:true});assert.equal(response.error.code,'unsupported_backend');assert.equal(response._meta.outcome,'not_started')
  const afterPanes=await read('pane.list');assert.deepEqual(afterPanes,prior)
  const after=snapshot();assert.deepEqual(after,before);return {before,after,response,prior,afterPanes}
 })
}finally{await f.cleanup()}
