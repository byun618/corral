// Preserve the review-codex boundary fixture with local imports and explicit error/stage oracles.
// Hold observed responses, not backend dispatch: an App-loop turn may exceed the final 40ms.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {fixture,rpc,until,pause} from './lib.mjs'
const f=await fixture('wait'),clients=new Set();let hook,server,backend
const proxyPath=path.join(f.root,'proxy.sock'),env={...f.env,CORRAL_BACKEND_SOCKET:proxyPath}
const checkError=(result,code)=>{assert.equal(result.error.code,code);assert.equal(result.error.stage,'backend');assert.equal(result._meta.outcome,'not_started')}
try {
  backend=await f.startBackend()
  server=net.createServer(s=>{clients.add(s);s.on('close',()=>clients.delete(s));s.on('error',()=>{});let buffer='',accepted=false;s.setEncoding('utf8');s.on('data',c=>{buffer+=c;if(accepted||!buffer.includes('\n'))return;accepted=true;void(async()=>{const req=JSON.parse(buffer.split('\n')[0]);try{const res=hook?await hook(req,()=>rpc(f.socket,req)):await rpc(f.socket,req);if(!s.destroyed)s.end(JSON.stringify(res)+'\n')}catch(e){f.observations.push({proxyError:String(e)});s.destroy()}})()})})
  await new Promise(r=>server.listen(proxyPath,r));fs.chmodSync(proxyPath,0o600)
  await f.serve(env);await f.cli(['repo','add','--path',f.repo],{env});const a=await f.receiver('a',env)
  await f.check('R3-near-deadline-large-read-timeout',async()=>{
    const cursor=(await f.cli(['terminal','read','--terminal',a.terminal.handle],{env})).result.cursor
    a.output(Buffer.alloc(900000,120));await pause(100);let barrier
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read'&&!barrier){barrier={deadline:req.params.deadline_ms,receivedAt:Date.now()};f.observations.push({boundary:barrier});barrier.forwardAt=Date.now();const response=await forward();barrier.responseAt=Date.now();barrier.responseCode=response.error?.code??'success';await pause(Math.max(1,barrier.deadline-Date.now()+25));barrier.deliveredAt=Date.now();return response}return forward()}
    const result=await f.cli(['terminal','wait','--terminal',a.terminal.handle,'--for','output','--cursor',cursor,'--text','NEVER','--timeout-ms','600'],{env,fail:true})
    await until(()=>barrier?.deliveredAt,'late read returned');hook=undefined;checkError(result,'wait_timeout')
    assert.equal(barrier.responseCode,'success');assert(barrier.responseAt<barrier.deadline);assert(barrier.deliveredAt>=barrier.deadline)
    return {barrier,result,injection:'real large PTY read, response held past deadline'}
  })
  await f.check('R3-near-deadline-stale-is-distinct',async()=>{
    const victim=await f.receiver('stale',env);let barrier
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read'&&!barrier){barrier={deadline:req.params.deadline_ms,receivedAt:Date.now()};f.observations.push({boundary:barrier});await f.backendRpc('pane.close',{pane_id:victim.terminal.paneId});barrier.forwardAt=Date.now();const response=await forward();barrier.responseAt=Date.now();barrier.response=response;await pause(Math.max(1,barrier.deadline-Date.now()-40));barrier.deliveredAt=Date.now();return response}return forward()}
    const result=await f.cli(['terminal','wait','--terminal',victim.terminal.handle,'--for','output','--text','NEVER','--timeout-ms','600'],{env,fail:true});hook=undefined
    checkError(result,'stale_terminal');assert(barrier.responseAt<barrier.deadline);assert(barrier.deliveredAt<barrier.deadline);assert.equal(barrier.response.error.code,'stale_terminal');return {barrier,result}
  })
  await f.check('R3-shutdown-response-is-distinct',async()=>{
    let barrier
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read'&&!barrier){barrier={deadline:req.params.deadline_ms,receivedAt:Date.now()};f.observations.push({boundary:barrier});await pause(Math.max(1,barrier.deadline-Date.now()-40));barrier.responseAt=Date.now();barrier.response={id:req.id,error:{code:'server_unavailable',message:'server is shutting down'}};return barrier.response}return forward()}
    const result=await f.cli(['terminal','wait','--terminal',a.terminal.handle,'--for','output','--text','NEVER','--timeout-ms','600'],{env,fail:true});hook=undefined
    checkError(result,'server_unavailable');assert.equal(result.error.message,'server is shutting down');assert(barrier.responseAt<barrier.deadline)
    return {barrier,result,injection:'proxy shutdown error matching reviewer-observed backend response'}
  })
  await f.check('R3-near-deadline-socket-disconnect-is-distinct',async()=>{
    let barrier
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read'&&!barrier){barrier={deadline:req.params.deadline_ms,receivedAt:Date.now()};f.observations.push({boundary:barrier});await f.stop(backend);barrier.forwardAt=Date.now();try{return await forward()}catch(error){barrier.disconnectedAt=Date.now();barrier.transportError=String(error);await pause(Math.max(1,barrier.deadline-Date.now()-40));barrier.deliveredAt=Date.now();throw error}}return forward()}
    const result=await f.cli(['terminal','wait','--terminal',a.terminal.handle,'--for','output','--text','NEVER','--timeout-ms','600'],{env,fail:true});hook=undefined
    checkError(result,'backend_unavailable');assert(barrier.disconnectedAt<barrier.deadline);assert(barrier.deliveredAt<barrier.deadline);return {barrier,result}
  })
}finally{for(const c of clients)c.destroy();if(server)await new Promise(r=>server.close(r));await f.cleanup()}
