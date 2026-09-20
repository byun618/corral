import fs from 'node:fs'
import assert from 'node:assert/strict'
import { fixture, pause, until, requestId } from './lib.mjs'
const f = await fixture('live')
let backend, runtime
try {
  backend = await f.startBackend(); runtime = await f.serve()
  await f.cli(['repo', 'add', '--path', f.repo])
  const a = await f.receiver('a'), b = await f.receiver('b', f.env, f.linked), handle = a.terminal.handle
  await f.check('F1-F2-create-discover', async () => {
    const list = (await f.cli(['terminal', 'list'])).result
    assert.equal(list.terminals.length, 2); assert.notEqual(a.terminal.ptyId, b.terminal.ptyId)
    assert.notEqual(a.terminal.worktreeId, b.terminal.worktreeId)
    const shown = (await f.cli(['terminal', 'show', '--terminal', handle])).result
    assert.equal(shown.terminal.ptyId, a.terminal.ptyId); assert.equal(shown.capabilities.conditionalProcess, false)
    const limited = (await f.cli(['terminal', 'list', '--limit', '1'])).result; assert.equal(limited.truncated, true)
    assert.equal(fs.readFileSync(a.starts, 'utf8'), 'start\n'); return { a: a.terminal, b: b.terminal, list, shown }
  })
  await f.check('F5-literal', async () => {
    const text = '한글 😀 e\u0301\n"double" \'single\' $HOME `echo WRONG` \\ backslash  '
    await f.cli(['terminal', 'send', '--terminal', handle, '--text', text, '--enter'])
    await f.cli(['terminal', 'send', '--terminal', handle, '--stdin'], { stdin: text })
    await f.cli(['terminal', 'send', '--terminal', handle, '--text', '', '--enter'])
    const expected = Buffer.from(text + '\r' + text + '\r')
    await until(() => a.input().length === expected.length, 'literal bytes'); assert.deepEqual(a.input(), expected); assert.equal(b.input().length, 0)
    return { expectedBase64: expected.toString('base64'), actualBase64: a.input().toString('base64') }
  })
  await f.check('F2-S3-rejections', async () => {
    const before = a.input(), results = []
    for (const args of [ ['terminal','send','--text','missing'], ['terminal','close','--terminal','bogus'], ['terminal','send','--terminal',handle,'--text','bad','--expect-process','p1.stale'], ['terminal','close','--terminal',handle,'--expect-process','p1.stale'], ['terminal','send','--terminal',handle,'--stdin','--text','bad'], ['terminal','send','--terminal',handle,'--interrupt','--enter'], ['terminal','read','--terminal',handle,'--screen','--cursor','bad'], ['terminal','read','--terminal',handle,'--limit','-1'], ['terminal','read','--terminal',handle,'--cursor','bad'], ['terminal','wait','--terminal',handle,'--for','tui-idle'], ['terminal','send','--terminal',handle,'--bogus'] ]) results.push(await f.cli(args,{fail:true}))
    assert.equal(results[2].error.code,'unsupported'); assert.equal(results[2]._meta.outcome,'not_started'); assert.deepEqual(a.input(),before); return results
  })
  let cursor
  await f.check('F4-raw-multibyte', async () => {
    cursor = (await f.cli(['terminal','read','--terminal',handle])).result.cursor
    const text = 'raw 한글 😀 e\u0301\r\n', bytes = Buffer.from(text), chunks = []
    for (const byte of bytes) { a.output(Buffer.from([byte])); await pause(15); const r = (await f.cli(['terminal','read','--terminal',handle,'--cursor',cursor,'--limit','1'])).result; cursor=r.cursor; chunks.push(r) }
    assert.deepEqual(Buffer.concat(chunks.map(c=>Buffer.from(c.bytesBase64,'base64'))),bytes)
    assert.equal(chunks.map(c=>c.text).join(''),text)
    const empty = (await f.cli(['terminal','read','--terminal',handle,'--cursor',cursor])).result; assert.equal(empty.text,''); return chunks
  })
  await f.check('F6-ready-output-timeout-concurrent', async () => {
    await f.cli(['terminal','wait','--terminal',handle,'--for','ready'])
    const stale = await f.cli(['terminal','wait','--terminal',handle,'--for','output','--cursor',cursor,'--text','raw','--timeout-ms','300'],{fail:true}); assert.equal(stale.error.code,'wait_timeout')
    const waiting = f.cli(['terminal','wait','--terminal',handle,'--for','output','--cursor',cursor,'--text','NEW_MARK','--timeout-ms','3000'])
    await pause(100); await f.cli(['terminal','send','--terminal',b.terminal.handle,'--text','during-wait']); a.output('NEW_MARK')
    const output = (await waiting).result; cursor=output.output.cursor; assert(output.output.text.includes('NEW_MARK')); return { stale, output }
  })
  await f.check('S4-retry-concurrent-conflict', async () => {
    const id=requestId(), args=['terminal','send','--terminal',handle,'--text','ONCE','--request-id',id], before=a.input().length
    const replies=await Promise.all([f.cli(args),f.cli(args),f.cli(args)]); await until(()=>a.input().length===before+4,'one send')
    assert.equal(replies.filter(r=>!r.result.replayed).length,1)
    const conflict=await f.cli([...args.slice(0,5),'different','--request-id',id],{fail:true}); assert.equal(conflict.error.code,'request_conflict')
    return {replies,conflict,actual:a.input().subarray(before).toString()}
  })
  await f.check('F4-overflow-gap', async () => {
    const old=cursor, data=Buffer.alloc(1200000,120); a.output(data); await pause(300)
    const r=(await f.cli(['terminal','read','--terminal',handle,'--cursor',old,'--limit','17'])).result
    assert(r.gap); assert(r.truncated); assert(r.retainedFrom>0); assert.equal(Buffer.from(r.bytesBase64,'base64').length,17)
    const wrong=await f.cli(['terminal','read','--terminal',b.terminal.handle,'--cursor',r.cursor],{fail:true}); assert.equal(wrong.error.code,'invalid_cursor'); return {r,wrong}
  })
  await f.check('S1-runtime-restart-retry', async () => {
    const id=requestId(),args=['terminal','send','--terminal',handle,'--text','PERSIST','--request-id',id]
    const before=a.input().length,first=await f.cli(args); await until(()=>a.input().length===before+7,'persist send')
    const cursorBefore=(await f.cli(['terminal','read','--terminal',handle])).result
    let restartCursor=cursorBefore.cursor
    while(true){const page=(await f.cli(['terminal','read','--terminal',handle,'--cursor',restartCursor])).result;restartCursor=page.cursor;if(!page.hasMore)break}
    await f.stop(runtime); runtime=await f.serve(f.env,'serve-restart')
    a.output('AFTER_RUNTIME_RESTART');await pause(100)
    const newOutput=(await f.cli(['terminal','read','--terminal',handle,'--cursor',restartCursor])).result;assert.equal(newOutput.text,'AFTER_RUNTIME_RESTART')
    const again=await f.cli(args); assert(again.result.replayed); assert.equal(a.input().length,before+7)
    const show=await f.cli(['terminal','show','--terminal',handle]); assert.equal(show.result.terminal.handle,handle)
    const unknown=await f.cli(['terminal','send','--terminal',handle,'--text','NO','--request-id',`r1.${Date.now()-60000}.00000000-0000-4000-8000-000000000001`],{fail:true}); assert.equal(unknown.error.code,'outcome_unknown'); return {first,again,show,unknown}
  })
  await f.check('F7-F6-close-and-exit', async () => {
    const waiting=f.cli(['terminal','wait','--terminal',handle,'--for','exit','--timeout-ms','4000'])
    await pause(100); const close=await f.cli(['terminal','close','--terminal',handle]), exit=await waiting
    assert.equal(exit.result.exitCode,null); assert.equal(close.result.exitCode,null)
    await f.cli(['terminal','show','--terminal',b.terminal.handle]); const stale=await f.cli(['terminal','close','--terminal',handle],{fail:true}); assert.equal(stale.error.code,'stale_terminal')
    return {close,exit,stale}
  })
  await f.check('S1-backend-restart', async () => {
    const old=b.terminal.handle; await f.stop(backend); backend=await f.startBackend('backend-restart')
    const stale=await f.cli(['terminal','send','--terminal',old,'--text','NO'],{fail:true}); assert.equal(stale.error.code,'stale_terminal'); return stale
  })
} finally { await f.cleanup() }
