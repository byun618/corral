// Regression for both reviewers' r0 receipt-loss counterexample, using this checkout's build.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {fixture, until, requestId, pause} from './lib.mjs'
const f=await fixture('loss')
let runtime
try {
  await f.startBackend();runtime=await f.serve();await f.cli(['repo','add','--path',f.repo])
  const a=await f.receiver('a')
  for(const action of ['send','create'])await f.check('R1-'+action+'-missing-receipt-no-new-effect',async()=>{
    const id=requestId(),marker=path.join(f.root,'create.starts'),command=`printf 'start\\n' >> '${marker}'`
    const args=action==='send'?['terminal','send','--terminal',a.terminal.handle,'--text','ONCE_LOST','--request-id',id]:['terminal','create','--worktree',f.repo,'--command',command,'--request-id',id]
    const first=await f.cli(args)
    await until(()=>action==='send'?a.input().toString()==='ONCE_LOST':fs.existsSync(marker)&&fs.readFileSync(marker,'utf8')==='start\n','first effect')
    const replay=await f.cli(args);assert.equal(replay.result.replayed,true)
    const before=(await f.cli(['terminal','list'])).result.terminals.map(t=>t.ptyId).sort()
    const file=path.join(f.env.CORRAL_USER_DATA,'runtime/terminal-receipts',id+'.json'),saved=JSON.parse(fs.readFileSync(file))
    fs.unlinkSync(file)
    const retries=await Promise.all([f.cli(args,{fail:true}),f.cli(args,{fail:true})])
    for(const result of retries){assert.equal(result.error.code,'outcome_unknown');assert.equal(result.error.stage,'receipt');assert.equal(result._meta.outcome,'unknown')}
    const changed=[...args];changed[changed.indexOf(action==='send'?'--text':'--command')+1]='DIFFERENT'
    const conflict=await f.cli(changed,{fail:true});assert.equal(conflict.error.code,'request_conflict')
    assert(!fs.existsSync(file),'missing receipt was not recreated')
    await f.stop(runtime);runtime=await f.serve(f.env,'serve-after-'+action+'-loss')
    const restart=await f.cli(args,{fail:true});assert.equal(restart.error.code,'outcome_unknown');assert.equal(restart.error.stage,'receipt')
    await pause(100)
    const after=(await f.cli(['terminal','list'])).result.terminals.map(t=>t.ptyId).sort()
    assert.deepEqual(after,before);assert.equal(a.input().toString(),'ONCE_LOST')
    if(action==='create')assert.equal(fs.readFileSync(marker,'utf8'),'start\n')
    return {first,replay,deletedReceipt:saved,retries,conflict,restart,beforePtys:before,afterPtys:after,actualInput:a.input().toString(),actualStarts:action==='create'?fs.readFileSync(marker,'utf8'):null}
  })
}finally{await f.cleanup()}
