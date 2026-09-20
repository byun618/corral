import assert from 'node:assert/strict'
import {fixture,until,pause} from './lib.mjs'
const f=await fixture('bom')
try {
  await f.startBackend();await f.serve();await f.cli(['repo','add','--path',f.repo]);const a=await f.receiver('a')
  await f.check('R2-UTF8-BOM-stdin-and-text-literal',async()=>{
    const input=Buffer.from('\uFEFF한글 😀')
    const stdin=await f.cli(['terminal','send','--terminal',a.terminal.handle,'--stdin'],{stdin:input})
    const text=await f.cli(['terminal','send','--terminal',a.terminal.handle,'--text',input.toString('utf8')])
    const expected=Buffer.concat([input,input]);await until(()=>a.input().length===expected.length,'literal BOM bytes')
    assert.equal(stdin.result.bytes,14);assert.equal(text.result.bytes,14);assert.deepEqual(a.input(),expected)
    return {stdin,text,inputBase64:input.toString('base64'),actualBase64:a.input().toString('base64'),expectedBase64:expected.toString('base64')}
  })
  await f.check('R2-BOM-byte-limit-and-invalid-input-no-effect',async()=>{
    const before=a.input(),limit=Buffer.concat([Buffer.from('\uFEFF'),Buffer.alloc(65533,120)])
    const accepted=await f.cli(['terminal','send','--terminal',a.terminal.handle,'--stdin'],{stdin:limit})
    assert.equal(accepted.result.bytes,65536);await until(()=>a.input().length===before.length+limit.length,'BOM at byte limit')
    const rejected=[]
    for(const input of [Buffer.concat([limit,Buffer.from('x')]),Buffer.from([0xef,0xbb,0xbf,0xc0,0xaf]),Buffer.from([0xe2,0x82]),Buffer.from('\uFEFFbad\0text')]){
      const result=await f.cli(['terminal','send','--terminal',a.terminal.handle,'--stdin'],{stdin:input,fail:true})
      assert.equal(result.error.code,'invalid_argument');assert.equal(result._meta.outcome,'not_started')
      rejected.push({bytes:input.length,inputBase64:input.length<32?input.toString('base64'):null,result})
    }
    await pause(100);assert.deepEqual(a.input(),Buffer.concat([before,limit]));return {accepted,rejected,receivedBytes:a.input().length}
  })
}finally{await f.cleanup()}
