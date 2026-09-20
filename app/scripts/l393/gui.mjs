import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fixture, app, pause, until, quote } from './lib.mjs'
const f = await fixture('gui')
try {
  await f.startBackend(); await f.serve(); await f.cli(['repo','add','--path',f.repo])
  const a=await f.receiver('a'), b=await f.receiver('b'), first=f.client('gui1'), second=f.client('gui2')
  await f.gui(first,'gui1'); await f.gui(second,'gui2')
  const ev=async(env,code)=>(await f.control(env,{cmd:'eval',code})).result
  const selected=env=>ev(env,'document.querySelector("[data-term-pane-box].is-selected")?.dataset.termPaneBox')
  const handles=async env=>(await f.cli(['terminal','list'],{env})).result.terminals
  const ah=(await handles(first)).find(t=>t.ptyId===a.terminal.ptyId).handle
  const bh=(await handles(second)).find(t=>t.ptyId===b.terminal.ptyId).handle
  await f.check('F8-two-GUI-focus-input',async()=>{
    await f.cli(['terminal','switch','--terminal',ah],{env:first}); await f.cli(['terminal','focus','--terminal',bh],{env:second})
    assert.equal(await selected(first),a.terminal.paneId); assert.equal(await selected(second),b.terminal.paneId)
    await f.cli(['terminal','focus','--terminal',ah],{env:first})
    assert.equal(await selected(second),b.terminal.paneId)
    await f.control(first,{cmd:'type',text:'FIRST_GUI'}); await f.control(second,{cmd:'type',text:'SECOND_GUI'})
    await until(()=>a.input().toString()==='FIRST_GUI'&&b.input().toString()==='SECOND_GUI','separate GUI input')
    await f.control(first,{cmd:'shot',name:'gui1-a'}); await f.control(second,{cmd:'shot',name:'gui2-b'})
    return {firstSelected:await selected(first),secondSelected:await selected(second),aInput:a.input().toString(),bInput:b.input().toString()}
  })
  await f.check('F1-F8-no-focus-create-rename',async()=>{
    const before=await selected(first)
    const created=(await f.cli(['terminal','create','--worktree',f.linked,'--title','other-worktree'],{env:first})).result.terminal
    await pause(300); assert.equal(await selected(first),before)
    await f.cli(['terminal','rename','--terminal',created.handle,'--title','CLI renamed'],{env:first})
    await f.cli(['terminal','switch','--terminal',created.handle],{env:first})
    assert.equal(await selected(first),created.paneId)
    await until(async()=>await ev(first,'document.querySelector("[data-main-tab].is-active")?.textContent.includes("CLI renamed")'),'renamed GUI tab')
    await f.control(first,{cmd:'shot',name:'created-renamed'})
    const focused=(await f.cli(['terminal','create','--worktree',f.repo,'--title','focused-create','--focus'],{env:first})).result.terminal
    assert.equal(await selected(first),focused.paneId)
    await f.cli(['terminal','close','--terminal',focused.handle],{env:first})
    await f.cli(['terminal','switch','--terminal',ah],{env:first})
    return {created,focused,selectedBefore:before}
  })
  await f.check('F3-ANSI-CR-alt-unicode-screen',async()=>{
    const observed=[]
    for(const [name,text,expected] of [
      ['normal','\x1b[2J\x1b[Habcdef\rXY\x1b[2;1H한글 😀 e\u0301','XYcdef'],
      ['alternate','\x1b[?1049h\x1b[2J\x1b[HALT 한글 😀 e\u0301\x1b[2;1Hmove\x1b[2;1HDONE','ALT 한글'],
      ['restored','\x1b[?1049l','XYcdef']]) {
      a.output(text)
      const gui=await until(async()=>{const r=await f.control(first,{cmd:'term-read'});return r.term.paneId===a.terminal.paneId&&r.term.lines.join('\n').includes(expected)?r.term:false},'GUI '+name)
      const screen=(await f.cli(['terminal','read','--terminal',ah,'--screen'],{env:first})).result
      assert(screen.text.includes(expected)); assert.equal(screen.source,'screen-snapshot'); assert.equal(screen.cursor,null)
      const screenLines=screen.text.split('\n').map(line=>line.trimEnd()).filter(line=>line.length)
      const guiLines=gui.lines.map(line=>line.trimEnd()).filter(line=>line.length)
      assert.deepEqual(screenLines,guiLines)
      await f.control(first,{cmd:'shot',name:'screen-'+name}); observed.push({name,screen,gui})
    }
    return observed
  })
  await f.check('F9-GUI-split-explicit-pane',async()=>{
    await f.cli(['terminal','switch','--terminal',ah],{env:first})
    const prior=await handles(first)
    await f.control(first,{cmd:'key',keyCode:'D',modifiers:['meta']})
    const split=await until(async()=>{const list=await handles(first);return list.find(t=>!prior.some(p=>p.ptyId===t.ptyId))},'GUI split terminal')
    assert.equal(split.tabId,a.terminal.tabId)
    await f.cli(['terminal','rename','--terminal',split.handle,'--title','shared tab'],{env:first})
    assert.equal((await f.cli(['terminal','show','--terminal',ah],{env:first})).result.terminal.title,'shared tab')
    const log=path.join(f.root,'split.input'),fifo=path.join(f.root,'split.fifo'),starts=path.join(f.root,'split.starts')
    assert.equal((await f.run('mkfifo',[fifo])).exit,0)
    const command=['python3',path.join(app,'scripts/l393/receiver.py'),log,fifo,starts].map(quote).join(' ')
    await f.cli(['terminal','send','--terminal',split.handle,'--text',command,'--enter'],{env:first}); await until(()=>fs.existsSync(starts),'split receiver'); await pause(100)
    await f.cli(['terminal','switch','--terminal',ah],{env:first})
    const before=a.input()
    await f.cli(['terminal','send','--terminal',split.handle,'--text','SPLIT_ONLY'],{env:first})
    await until(()=>fs.existsSync(log)&&fs.readFileSync(log,'utf8')==='SPLIT_ONLY','split input'); assert.deepEqual(a.input(),before)
    fs.writeFileSync(fifo,'SPLIT_OUTPUT'); await pause(100)
    assert((await f.cli(['terminal','read','--terminal',split.handle],{env:first})).result.text.includes('SPLIT_OUTPUT'))
    await f.control(first,{cmd:'shot',name:'split'})
    await f.cli(['terminal','close','--terminal',split.handle],{env:first})
    await f.cli(['terminal','show','--terminal',ah],{env:first}); assert.deepEqual(a.input(),before)
    return {split,received:fs.readFileSync(log,'utf8'),sibling:a.terminal.paneId}
  })
  await f.check('F7-interrupt-shell-preserved',async()=>{
    const terminal=(await f.cli(['terminal','create','--worktree',f.repo,'--command','sleep 120'],{env:first})).result.terminal
    await until(async()=>{const p=(await f.cli(['terminal','show','--terminal',terminal.handle],{env:first})).result.process;return p.foregroundGroupId!==p.shellPid},'sleep foreground')
    await f.cli(['terminal','send','--terminal',terminal.handle,'--interrupt'],{env:first})
    const after=await until(async()=>{const r=(await f.cli(['terminal','show','--terminal',terminal.handle],{env:first})).result;return r.process.foregroundGroupId===r.process.shellPid?r:false},'shell restored')
    await f.cli(['terminal','close','--terminal',terminal.handle],{env:first}); return after
  })
  await f.check('F8-headless-focus-no-effect',async()=>{
    const before=(await f.cli(['terminal','list'])).result.totalCount
    for(const args of [['terminal','focus','--terminal',a.terminal.handle],['terminal','create','--worktree',f.repo,'--focus']]) {const r=await f.cli(args,{fail:true});assert.equal(r.error.code,'ui_unavailable');assert.equal(r._meta.outcome,'not_started')}
    assert.equal((await f.cli(['terminal','list'])).result.totalCount,before)
    const foreign=await f.cli(['terminal','send','--terminal',ah,'--text','NO'],{env:second,fail:true}); assert.equal(foreign.error.code,'invalid_terminal')
    return foreign
  })
} finally {await f.cleanup()}
