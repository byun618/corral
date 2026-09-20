import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {app} from './lib.mjs'
const raw=path.resolve(process.env.CORRAL_VERIFY_RAW??path.join(app,'../specs/LIFE-393-cli-terminal/raw/codex'))
fs.mkdirSync(raw,{recursive:true})
const base=fs.realpathSync(fs.mkdtempSync('/tmp/l393-' + (process.env.CORRAL_VERIFY_OWNER ?? 'codex') + '-lint-'))
const archive=spawnSync('git',['archive','b74b335','app'],{cwd:path.dirname(app),maxBuffer:32*1024*1024})
if(archive.status!==0)throw Error(archive.stderr.toString())
const unpack=spawnSync('tar',['-xf','-','-C',base],{input:archive.stdout});if(unpack.status!==0)throw Error(unpack.stderr.toString())
fs.symlinkSync(path.join(app,'node_modules'),path.join(base,'app/node_modules'))
const counts={},summary={baseCommit:'b74b335',node:process.version}
for(const[name,cwd]of[['base',path.join(base,'app')],['current',app]]){
  const args=[path.join(app,'node_modules/eslint/bin/eslint.js'),'.','--format','json']
  const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024})
  fs.writeFileSync(path.join(raw,`lint-${name}-final.json`),result.stdout);fs.writeFileSync(path.join(raw,`lint-${name}-final.err`),result.stderr)
  if(![0,1].includes(result.status))throw Error('Lint failed to execute: '+result.stderr)
  const count=new Map()
  for(const file of JSON.parse(result.stdout))for(const message of file.messages){const key=JSON.stringify([path.relative(cwd,file.filePath),message.ruleId,message.message]);count.set(key,(count.get(key)??0)+1)}
  counts[name]=count;summary[name]={cwd,argv:[process.execPath,...args],exit:result.status,violations:[...count.values()].reduce((a,b)=>a+b,0)}
}
summary.new=[...counts.current].filter(([key,count])=>count>(counts.base.get(key)??0)).map(([key,count])=>({key:JSON.parse(key),count:count-(counts.base.get(key)??0)}))
fs.writeFileSync(path.join(raw,'lint-delta.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));if(summary.new.length)process.exitCode=1
