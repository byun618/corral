import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
export async function verifyFix({ev,key,click,search,action,count,until,backendRpc,send,observations,root,repo,workspaceId,bin}) {
 const selected=()=>ev(`document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox`)
 const snapshot=()=>ev(`(()=>{const i=document.querySelector('[role=combobox]'),s=document.querySelector('[role=option][aria-selected=true]');return {selected:s?.dataset.paletteEntry??null,active:i?.getAttribute('aria-activedescendant'),activeEntry:document.getElementById(i?.getAttribute('aria-activedescendant'))?.dataset.paletteEntry??null,rows:[...document.querySelectorAll('[role=option]')].map(e=>e.dataset.paletteEntry)}})()`)
 const steps=[]
 const check=async(expected,label)=>{const s=await snapshot();assert.equal(s.selected,expected,label);assert.equal(s.activeEntry,expected,label+' aria');if(expected)assert(s.active);else assert.equal(s.active,null);steps.push({label,...s});return s}
 const arrow=async(code,expected,label)=>{await ev('window.__keys=[]');await key(code);const events=await ev('window.__keys');assert(events.some(e=>e.key==='Arrow'+code&&e.code==='Arrow'+code&&e.trusted),JSON.stringify(events));await check(expected,label);steps.at(-1).events=events}
 await action('repo.select:'+fs.realpathSync(repo))
 // Four real tabs in stable server order; one initially excluded from the query.
 const fixtures=[]
 for(let i=0;i<4;i++){
   const t=await backendRpc('tab.create',{workspace_id:workspaceId});fixtures.push(t)
   await backendRpc('tab.rename',{tab_id:t.tab.tab_id,label:i===0?'excluded insertion':'fix-selection '+i})
 }
 const ids=fixtures.map(t=>'pane.switch:'+t.root_pane.pane_id)
 await until(async()=>JSON.stringify((await send({cmd:'state'})).state).includes('fix-selection 3'),'selection fixtures sync')
 await click('[data-palette-open]');await search('fix-selection');await check(ids[1],'initial')
 await arrow('Down',ids[2],'down');await arrow('Up',ids[1],'up');await arrow('Up',ids[3],'wrap up');await arrow('Down',ids[1],'wrap down');await arrow('Down',ids[2],'chosen second')
 await backendRpc('tab.close',{tab_id:fixtures[1].tab.tab_id});await until(async()=>(await snapshot()).rows.length===2,'front deletion');await check(ids[2],'front deletion preserves ID')
 await backendRpc('tab.rename',{tab_id:fixtures[0].tab.tab_id,label:'fix-selection inserted'});await until(async()=>(await snapshot()).rows[0]===ids[0],'front insertion');await check(ids[2],'front insertion preserves ID')
 await key('Enter');await until(async()=>await selected()===fixtures[2].root_pane.pane_id,'Enter intended pane');steps.push({label:'Enter destination',pane:await selected()})
 await click('[data-palette-open]');await search('fix-selection');await arrow('Down',ids[2],'reselect deleted target')
 await backendRpc('tab.close',{tab_id:fixtures[2].tab.tab_id});await until(async()=>!(await snapshot()).rows.includes(ids[2]),'selected target removed');await check(null,'missing selection is empty');const before=await selected();await key('Enter');assert.equal(await count('[data-command-palette]'),1);assert.equal(await selected(),before)
 await arrow('Down',ids[0],'explicit navigation restores selection');await key('Enter');await until(async()=>await selected()===fixtures[0].root_pane.pane_id,'reselected destination')
 await click('[data-palette-open]');await search('no-such-fix-selection-zzzz');await check(null,'no results');await arrow('Down',null,'no result down');await arrow('Up',null,'no result up');await key('Enter');assert.equal(await count('[data-command-palette]'),1)
 await search('fix-selection');const current=(await snapshot()).selected
 for(const code of ['Left','Right']){const before=await ev('document.querySelector("[role=combobox]").selectionStart');await arrow(code,current,'caret '+code);const after=await ev('document.querySelector("[role=combobox]").selectionStart');assert.equal(after,before+(code==='Left'?-1:1))}
 assert.equal(await ev('document.querySelector("[role=combobox]").getAttribute("aria-autocomplete")'),'list');await key('Escape')
 observations.push({selectionAndKeys:steps})
 // Exercise all action variants with observable state changes.
 const effects=[]
 const effect=async(id,read,verify)=>{const before=await read();await action(id);await until(async()=>verify(before,await read()),id+' effect');effects.push({id,before,after:await read()})}
 const paneIds=async()=>(await backendRpc('pane.list')).panes.map(p=>p.pane_id)
 const split=async id=>{
   const before=await paneIds();await action(id)
   const after=await until(async()=>{const ids=await paneIds();return ids.length===before.length+1&&ids},id+' pane count')
   const added=after.filter(p=>!before.includes(p));assert.equal(added.length,1,id+' new pane')
   // Backend creation precedes renderer selection; directional baselines need both.
   await until(async()=>await selected()===added[0],id+' renderer selection')
   effects.push({id,before:before.length,after:after.length,created:added[0],selected:await selected()})
 }
 const tabs=()=>count('[data-main-tab]'),groups=()=>count('[data-tab-group]')
 await effect('terminal.new:0',tabs,(a,b)=>b===a+1)
 await split('terminal.split:0')
 const right=await selected();await effect('terminal.focus:0',selected,(a,b)=>a!==b);const left=await selected();await effect('terminal.focus:1',selected,(a,b)=>b===right&&a===left)
 await split('terminal.split:1')
 const down=await selected();await effect('terminal.focus:2',selected,(a,b)=>a!==b);const up=await selected();await effect('terminal.focus:3',selected,(a,b)=>b===down&&a===up)
 await effect('terminal.zoom:0',()=>count('[data-group-zoom-chip]'),(a,b)=>a===0&&b===1)
 await effect('terminal.zoom:0',()=>count('[data-group-zoom-chip]'),(a,b)=>a===1&&b===0)
 await effect('mru.open:0',selected,(a,b)=>a!==b);await effect('mru.open:1',selected,(a,b)=>a!==b)
 await effect('sidebar.toggle:0',()=>count('[data-sidebar]'),(a,b)=>a!==b);await effect('sidebar.toggle:0',()=>count('[data-sidebar]'),(a,b)=>a!==b)
 await effect('group.split:0',groups,(a,b)=>b===a+1);await effect('group.close:0',groups,(a,b)=>b===a-1)
 await effect('group.split:1',groups,(a,b)=>b===a+1);await effect('group.close:0',groups,(a,b)=>b===a-1)
 await effect('terminal.new:0',tabs,(a,b)=>b===a+1);await effect('terminal.close:0',tabs,(a,b)=>b===a-1)
 await action('shortcuts.settings');assert.equal(await count('[data-record="palette.open"]'),1);await key('Escape');effects.push({id:'shortcuts.settings',opened:true})
 observations.push({executedVariants:effects})
 // Prove the isolated shells resolve fixtures before any agent dispatch.
 await action('terminal.new:0');await click('[data-term-pane-box].is-selected')
 await send({cmd:'type',text:`command -v claude codex grok > '${root}/resolved-agents'\n`})
 await until(()=>fs.existsSync(path.join(root,'resolved-agents')),'fixture executable resolution')
 assert.deepEqual(fs.readFileSync(path.join(root,'resolved-agents'),'utf8').trim().split('\n'),['claude','codex','grok'].map(k=>path.join(bin,k)))
 for(const kind of ['claude','codex','grok']){
   const before=(await backendRpc('pane.list')).panes.map(p=>p.pane_id)
   await action('agent.start.'+kind);await until(()=>fs.existsSync(path.join(root,kind+'.started')),kind+' isolated executable')
   const started=fs.readFileSync(path.join(root,kind+'.started'),'utf8');assert.match(started,/tty=\/dev\/ttys/)
   const after=(await backendRpc('pane.list')).panes,added=after.filter(p=>!before.includes(p.pane_id));assert.equal(added.length,1)
   const info=await backendRpc('pane.process_info',{pane_id:added[0].pane_id})
   observations.push({agentExecutableFixture:{kind,started,pane:added[0],info,scope:'palette → existing GUI handler → backend agent.start → real PTY → isolated executable; no provider/model call',script:fs.readFileSync(path.join(bin,kind),'utf8')}})
 }
}
