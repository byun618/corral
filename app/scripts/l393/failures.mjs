import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { randomUUID, createHmac } from 'node:crypto'
import { fixture, rpc, until, pause, requestId } from './lib.mjs'
const f=await fixture('failure'), proxies=[]
async function proxy(socketPath,target,intercept) {
  const clients=new Set(), server=net.createServer(socket=>{
    clients.add(socket);socket.on('close',()=>clients.delete(socket));socket.on('error',()=>{})
    let buffer='',accepted=false;socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;if(accepted||!buffer.includes('\n'))return;accepted=true
      void(async()=>{try{const req=JSON.parse(buffer.split('\n')[0]);const response=await intercept(req,()=>rpc(target,req));if(response!==undefined&&!socket.destroyed)socket.end(JSON.stringify(response)+'\n')}catch(error){if(!socket.destroyed)socket.destroy();f.observations.push({proxyError:String(error)})}})()
    })
  })
  await new Promise(r=>server.listen(socketPath,r));fs.chmodSync(socketPath,0o600)
  proxies.push(async()=>{for(const c of clients)c.destroy();await new Promise(r=>server.close(r))})
  return server
}
let backend,runtime,hook
const proxyPath=path.join(f.root,'backend-proxy.sock'),env={...f.env,CORRAL_BACKEND_SOCKET:proxyPath}
try {
  backend=await f.startBackend()
  await proxy(proxyPath,f.socket,async(req,forward)=>hook?hook(req,forward):forward())
  runtime=await f.serve(env);await f.cli(['repo','add','--path',f.repo],{env})
  const a=await f.receiver('a',env), b=await f.receiver('b',env),handle=a.terminal.handle
  const mutation=req=>req.method==='corral.terminal'&&['pane.send_text','pane.close','tab.create','workspace.create'].includes(req.params.operation?.method)
  await f.check('S4-create-concurrent-lost-response',async()=>{
    const runtimeProxy=path.join(f.root,'runtime-proxy.sock');let dropped=false
    await proxy(runtimeProxy,path.join(env.CORRAL_USER_DATA,'runtime/rpc.sock'),async(req,forward)=>{const result=await forward();if(req.invocation.command==='terminal create'&&!dropped){dropped=true;return undefined}return result})
    const id=requestId(), marker=path.join(f.root,'create-once.starts'), command=`printf 'start\\n' >> '${marker}'`,args=['terminal','create','--worktree',f.repo,'--command',command,'--request-id',id]
    const first=f.cli([...args,'--socket',runtimeProxy,'--timeout-ms','600'],{env,fail:true})
    await until(()=>dropped,'response dropped');const concurrent=await Promise.all([f.cli(args,{env}),f.cli(args,{env})]);const lost=await first
    assert.equal(lost.error.code,'outcome_unknown');assert(concurrent.every(r=>r.result.replayed));await until(()=>fs.existsSync(marker),'marker started');assert.equal(fs.readFileSync(marker,'utf8'),'start\n')
    return {lost,concurrent,count:fs.readFileSync(marker,'utf8')}
  })
  await f.check('S4-send-response-loss-reconnect',async()=>{
    const rp=path.join(f.root,'send-proxy.sock');let dropped=false
    await proxy(rp,path.join(env.CORRAL_USER_DATA,'runtime/rpc.sock'),async(req,forward)=>{const result=await forward();if(req.invocation.command==='terminal send'&&!dropped){dropped=true;return undefined}return result})
    const id=requestId(),args=['terminal','send','--terminal',handle,'--text','LOST_ONCE','--request-id',id],before=a.input().length
    const lost=await f.cli([...args,'--socket',rp,'--timeout-ms','400'],{env,fail:true});assert.equal(lost.error.code,'outcome_unknown')
    const again=await f.cli(args,{env});assert(again.result.replayed);assert.equal(a.input().length,before+9);return {lost,again,received:a.input().subarray(before).toString()}
  })
  await f.check('S5-deadline-before-effect',async()=>{
    let held,release,backendResponse;const gate=new Promise(r=>release=r)
    hook=async(req,forward)=>{if(mutation(req)&&!held){held=req;await gate;backendResponse=await forward();return backendResponse}return forward()}
    const before=a.input(),pending=f.cli(['terminal','send','--terminal',handle,'--text','TOO_LATE','--timeout-ms','250'],{env,fail:true})
    await until(()=>held,'held backend mutation');const result=await pending;await pause(30);release();await until(()=>backendResponse,'late backend response')
    assert.equal(backendResponse.error.code,'deadline_exceeded');assert.deepEqual(a.input(),before);hook=undefined;return {result,held,backendResponse}
  })
  await f.check('S5-cancel-queued-before-effect',async()=>{
    let held,release;const gate=new Promise(r=>release=r)
    hook=async(req,forward)=>{if(mutation(req)&&!held){held=req;await gate}return forward()}
    const first=f.cli(['terminal','send','--terminal',handle,'--text','FIRST'],{env})
    await until(()=>held,'first holds mutation lane')
    const socket=net.createConnection(path.join(env.CORRAL_USER_DATA,'runtime/rpc.sock'))
    await new Promise(r=>socket.once('connect',r));socket.write(JSON.stringify({version:1,id:'cancelled',timeoutMs:4000,invocation:{command:'terminal send',flags:{terminal:handle,text:'CANCELLED','request-id':requestId()},args:[],cwd:f.repo}})+'\n')
    await pause(100);socket.destroy();await pause(50);const before=a.input().length;release();await first;await pause(100);hook=undefined
    assert.equal(a.input().subarray(before).toString(),'FIRST');return {received:a.input().subarray(before).toString(),queuedClosed:true}
  })
  await f.check('S4-crash-pending-receipt',async()=>{
    let accepted,release;const gate=new Promise(r=>release=r)
    hook=async(req,forward)=>{const response=await forward();if(mutation(req)&&!accepted){accepted=response;await gate}return response}
    const id=requestId(),args=['terminal','send','--terminal',handle,'--text','CRASH_ONCE','--request-id',id],before=a.input().length
    const pending=f.cli(args,{env,fail:true});await until(()=>accepted,'accepted before crash');await until(()=>a.input().length===before+10,'crash bytes')
    await f.stop(runtime,'SIGKILL');release();const lost=await pending;hook=undefined;runtime=await f.serve(env,'serve-after-crash')
    const retry=await f.cli(args,{env,fail:true});assert.equal(retry.error.code,'outcome_unknown');assert.equal(a.input().length,before+10);return {lost,retry,received:a.input().subarray(before).toString()}
  })
  await f.check('F6-cancel-output-wait',async()=>{
    let child,observed=false
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read')observed=true;return forward()}
    const pending=f.cli(['terminal','wait','--terminal',handle,'--for','output','--text','NEVER','--timeout-ms','4000'],{env,fail:true,onSpawn:p=>child=p})
    await until(()=>observed,'wait started');child.kill('SIGINT');const result=await pending;hook=undefined
    assert.equal(result.error.code,'request_cancelled');return result
  })
  await f.check('F6-PTY-replacement-wait',async()=>{
    const victim=await f.receiver('wait-victim',env)
    let held,release;const gate=new Promise(r=>release=r)
    hook=async(req,forward)=>{if(req.params?.operation?.method==='pane.read'&&req.params.pane_id===victim.terminal.paneId){held=req;await gate}return forward()}
    const pending=f.cli(['terminal','wait','--terminal',victim.terminal.handle,'--for','output','--text','NEVER','--timeout-ms','4000'],{env,fail:true})
    await until(()=>held,'wait read held before effect');await f.backendRpc('pane.close',{pane_id:victim.terminal.paneId})
    const replacement=await f.backendRpc('tab.create',{workspace_id:b.terminal.workspaceId,focus:false});release()
    const result=await pending;hook=undefined;assert.equal(result.error.code,'stale_terminal');return {result,replacement,held}
  })
  await f.check('S2-atomic-PTY-mismatch-live',async()=>{
    const epoch=(await f.backendRpc('corral.terminal')).epoch,results=[],before=b.input()
    for(const [method,params]of[['pane.send_text',{pane_id:b.terminal.paneId,text:'WRONG'}],['pane.send_text',{pane_id:b.terminal.paneId,text:'\x03'}],['pane.close',{pane_id:b.terminal.paneId}]]) {
      const result=await rpc(f.socket,{id:randomUUID(),method:'corral.terminal',params:{epoch,deadline_ms:Date.now()+1000,pane_id:b.terminal.paneId,terminal_id:a.terminal.ptyId,operation:{method,params}}})
      assert.equal(result.error.code,'stale_terminal');results.push(result)
    }
    assert.deepEqual(b.input(),before);await f.cli(['terminal','show','--terminal',b.terminal.handle],{env});return results
  })
  await f.check('F4-future-cursor-S4-expiry-limits',async()=>{
    const result=(await f.cli(['terminal','read','--terminal',handle],{env})).result
    const [kind,payload]=result.cursor.split('.'),decoded=JSON.parse(Buffer.from(payload,'base64url'));decoded.offset+=10000000
    const unsigned=kind+'.'+Buffer.from(JSON.stringify(decoded)).toString('base64url'),key=fs.readFileSync(path.join(env.CORRAL_USER_DATA,'runtime/terminal/key'))
    const future=unsigned+'.'+createHmac('sha256',key).update(unsigned).digest('base64url')
    const rejected=await f.cli(['terminal','read','--terminal',handle,'--cursor',future],{env,fail:true});assert.equal(rejected.error.code,'invalid_cursor')
    const expired=await f.cli(['terminal','send','--terminal',handle,'--text','NO','--request-id',`r1.${Date.now()-86400001}.${randomUUID()}`],{env,fail:true});assert.equal(expired.error.code,'request_expired')
    const before=a.input().length
    await f.cli(['terminal','send','--terminal',handle,'--stdin'],{env,stdin:'x'.repeat(65536)})
    await until(()=>a.input().length===before+65536,'input at limit')
    const over=await f.cli(['terminal','send','--terminal',handle,'--stdin'],{env,stdin:'x'.repeat(65537),fail:true});assert.equal(over.error.code,'invalid_argument')
    const nul=await f.cli(['terminal','send','--terminal',handle,'--stdin'],{env,stdin:'bad\0text',fail:true});assert.equal(nul.error.code,'invalid_argument')
    assert.equal(a.input().length,before+65536);return {rejected,expired,over,nul}
  })
  await f.check('S2-terminal-replacement-effect-boundary',async()=>{
    const results=[]
    for(const action of ['send','interrupt','close']) {
      const victim=await f.receiver('victim-'+action,env)
      let injected=false,replacement
      hook=async(req,forward)=>{
        if(mutation(req)&&!injected){injected=true;await f.backendRpc('pane.close',{pane_id:victim.terminal.paneId});replacement=await f.backendRpc('tab.create',{workspace_id:b.terminal.workspaceId,focus:false})}
        return forward()
      }
      const before=b.input(),args=action==='close'?['terminal','close','--terminal',victim.terminal.handle]:['terminal','send','--terminal',victim.terminal.handle,...action==='interrupt'?['--interrupt']:['--text','WRONG']]
      const result=await f.cli(args,{env,fail:true});hook=undefined;assert(injected);assert.equal(result.error.code,'stale_terminal');assert.equal(result._meta.outcome,'not_started')
      assert.deepEqual(b.input(),before);assert((await f.backendRpc('pane.list')).panes.some(p=>p.pane_id===replacement.root_pane.pane_id));results.push({action,result,replacement})
    }
    return results
  })
  await f.check('S2-backend-replacement-effect-boundary',async()=>{
    let injected=false,newEpoch,replacement
    hook=async(req,forward)=>{if(mutation(req)&&!injected){injected=true;await f.stop(backend);backend=await f.startBackend('backend-replaced');newEpoch=(await f.backendRpc('corral.terminal')).epoch;replacement=await f.backendRpc('workspace.create',{cwd:f.repo,focus:false})}return forward()}
    const result=await f.cli(['terminal','send','--terminal',handle,'--text','WRONG_BACKEND'],{env,fail:true});hook=undefined
    assert.equal(result.error.code,'stale_backend');assert.equal(result._meta.outcome,'not_started');assert.notEqual(newEpoch,a.terminal.epoch)
    const panes=await f.backendRpc('pane.list');assert(panes.panes.length>0);return {result,newEpoch,replacement,panes}
  })
  await f.check('F6-backend-disconnect-wait',async()=>{
    const target=(await f.cli(['terminal','list'],{env})).result.terminals[0],pending=f.cli(['terminal','wait','--terminal',target.handle,'--for','exit','--timeout-ms','3000'],{env,fail:true})
    await pause(100);await f.stop(backend);const result=await pending
    // SIGTERM may reply with a shutdown error or close the socket before a reply.
    assert(['backend_unavailable','server_unavailable'].includes(result.error.code),JSON.stringify(result))
    if(result.error.code==='server_unavailable')assert.equal(result.error.message,'server is shutting down')
    assert.equal(result.error.stage,'backend');assert.equal(result._meta.outcome,'not_started');return result
  })
} finally { for(const close of proxies.reverse())await close();await f.cleanup() }
