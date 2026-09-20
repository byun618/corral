import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import assert from 'node:assert/strict'
import {fixture,rpc} from './lib.mjs'
const f=await fixture('gui-race'),clients=new Set();let hook
const proxyPath=path.join(path.dirname(f.socket),'race.sock')
let server
try {
  await f.startBackend();await f.serve();await f.cli(['repo','add','--path',f.repo])
  const protectedPane=await f.receiver('protected')
  server=net.createServer(down=>{
    clients.add(down);down.on('close',()=>clients.delete(down));down.on('error',()=>{})
    let buffer=Buffer.alloc(0),taken=false
    const consume=chunk=>{buffer=Buffer.concat([buffer,chunk]);if(taken||!buffer.includes(10))return;taken=true;down.removeListener('data',consume)
      const req=JSON.parse(buffer.subarray(0,buffer.indexOf(10)).toString())
      if(req.method==='corral.terminal'&&['pane.send_text','pane.close'].includes(req.params.operation?.method)&&hook){
        void(async()=>{try{await hook(req);const result=await rpc(f.socket,req);f.observations.push({guardAfterGuiExit:{req,result}});if(!down.destroyed)down.end(JSON.stringify(result)+'\n')}catch(error){f.observations.push({error:String(error)});down.destroy()}})()
      }else{
        const up=net.createConnection(f.socket);clients.add(up);up.on('close',()=>clients.delete(up));up.on('error',()=>down.destroy());down.on('close',()=>up.destroy());up.once('connect',()=>{up.write(buffer);down.pipe(up);up.pipe(down)})
      }
    };down.on('data',consume)
  });await new Promise(r=>server.listen(proxyPath,r));fs.chmodSync(proxyPath,0o600)
  await f.check('S2-GUI-exit-send-interrupt-close',async()=>{
    const results=[]
    for(const action of ['send','interrupt','close']) {
      const victim=await f.receiver('victim-'+action),env={...f.client('gui-'+action),CORRAL_BACKEND_SOCKET:proxyPath}
      const gui=await f.gui(env,'gui-'+action)
      const target=(await f.cli(['terminal','list'],{env})).result.terminals.find(t=>t.ptyId===victim.terminal.ptyId)
      let injected=false
      hook=async()=>{injected=true;await f.stop(gui,'SIGKILL')}
      const args=action==='close'?['terminal','close','--terminal',target.handle]:['terminal','send','--terminal',target.handle,...action==='interrupt'?['--interrupt']:['--text','EXACT_TARGET']]
      const result=await f.cli(args,{env,fail:true});hook=undefined;assert(injected);assert.equal(result.error.code,'outcome_unknown')
      assert.equal(protectedPane.input().length,0);await f.cli(['terminal','show','--terminal',protectedPane.terminal.handle])
      results.push({action,result,victim:target,protected:protectedPane.terminal,protectedInput:protectedPane.input().toString('base64')})
    }
    return results
  })
}finally{for(const c of clients)c.destroy();if(server)await new Promise(r=>server.close(r));await f.cleanup()}
