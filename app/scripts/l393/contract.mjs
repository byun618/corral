import assert from 'node:assert/strict'
import {fixture,pause,until} from './lib.mjs'
const f=await fixture('contract')
try{
 await f.startBackend();await f.serve();await f.cli(['repo','add','--path',f.repo]);const a=await f.receiver('a'),handle=a.terminal.handle
 await f.check('Q1-help-schema-limits-errors',async()=>{
  const schema=JSON.parse((await f.run(process.execPath,[new URL('../../cli/corral.mjs',import.meta.url).pathname,'agent-context','--json'])).stdout)
  const terminal=schema.commands.filter(s=>s.command.startsWith('terminal '));assert.equal(terminal.length,9)
  const helps=[];for(const spec of terminal){const result=await f.cli([...spec.path,'--help']);assert.equal(result.commands[0].command,spec.command);helps.push(result)}
  await f.cli(['terminal','list','--limit','10000']);await f.cli(['terminal','read','--terminal',handle,'--limit','262144'])
  const failed=[]
  for(const args of [['terminal','list','--limit','10001'],['terminal','read','--terminal',handle,'--limit','262145'],['terminal','read','--terminal',handle,'--limit','1.2'],['terminal','rename','--terminal',handle,'--title','x'.repeat(1025)],['terminal','create','--worktree',f.repo,'--command','x'.repeat(65537)],['terminal','send','--terminal','same-title','--text','NO'],['terminal','close','--terminal',String(process.pid)],['terminal','split','--terminal',handle]])failed.push(await f.cli(args,{fail:true}))
  const title='x'.repeat(1024);await f.cli(['terminal','rename','--terminal',handle,'--title',title]);assert.equal((await f.cli(['terminal','show','--terminal',handle])).result.terminal.title,title)
  const command='printf LIMIT_OK; #'+ 'x'.repeat(65536-'printf LIMIT_OK; #'.length)
  const created=await f.cli(['terminal','create','--worktree',f.repo,'--command',command]);assert.equal(created.result.stage,'command_accepted');await f.cli(['terminal','close','--terminal',created.result.terminal.handle])
  assert.equal(a.input().length,0);return {commands:terminal.map(s=>s.command),helps,failed,commandLimitStage:created.result.stage}
 })
 await f.check('F2-ambiguous-worktree-no-effect',async()=>{
  for(const worktree of[f.repo,f.linked])await f.cli(['worktree','set','--worktree',worktree,'--display-name','collision'])
  const before=(await f.cli(['terminal','list'])).result.totalCount
  const result=await f.cli(['terminal','create','--worktree','name:collision'],{fail:true});assert.equal(result.error.code,'ambiguous_target');assert.equal(result._meta.outcome,'not_started');assert.equal((await f.cli(['terminal','list'])).result.totalCount,before);return result
 })
 await f.check('F6-no-cursor-requires-new-observation',async()=>{
  a.output('OLD_ONLY');await pause(100)
  const stale=await f.cli(['terminal','wait','--terminal',handle,'--for','output','--text','OLD_ONLY','--timeout-ms','300'],{fail:true});assert.equal(stale.error.code,'wait_timeout')
  const pending=f.cli(['terminal','wait','--terminal',handle,'--for','output','--text','FRESH','--timeout-ms','3000']);await pause(300);a.output('FRESH');const fresh=await pending;assert.equal(fresh.result.condition,'output');return {stale,fresh}
 })
 await f.check('F7-close-OS-process-oracle',async()=>{
  const before=(await f.cli(['terminal','show','--terminal',handle])).result.process
  const pids=[before.shellPid,...before.foreground.map(p=>p.pid)]
  const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}}
  assert(pids.every(alive))
  const closed=await f.cli(['terminal','close','--terminal',handle])
  await until(()=>pids.every(pid=>!alive(pid)),'closed shell and foreground process exit')
  return {before,pids,closed,aliveAfter:pids.map(alive)}
 })
}finally{await f.cleanup()}
