import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {app} from './lib.mjs'
const work=process.env.CORRAL_BACKEND_BUILD_ROOT
assert(work,'Set CORRAL_BACKEND_BUILD_ROOT')
const raw=path.resolve(process.env.CORRAL_VERIFY_RAW??path.join(app,'../specs/LIFE-393-cli-terminal/raw/codex'))
const source=JSON.parse(fs.readFileSync(path.join(app,'backend/source.json')))
const hash=buffer=>createHash('sha256').update(buffer).digest('hex')
assert.equal(hash(fs.readFileSync(path.join(work,'herdr.tar.gz'))),source.archiveSHA256)
const root=fs.mkdtempSync('/tmp/l393-' + (process.env.CORRAL_VERIFY_OWNER ?? 'codex') + '-source-'),extracted=path.join(root,'herdr-0.9.0')
const unpack=spawnSync('tar',['-xzf',path.join(work,'herdr.tar.gz'),'-C',root]);assert.equal(unpack.status,0)
const files=new Set()
for(const name of source.patches){
 const patch=fs.readFileSync(path.join(app,'backend',name));assert.equal(hash(patch),source.patchSHA256[name])
 const applied=spawnSync('patch',['-p1'],{cwd:extracted,input:patch});assert.equal(applied.status,0,applied.stdout.toString()+applied.stderr.toString())
 for(const line of patch.toString().split('\n'))if(line.startsWith('+++ b/'))files.add(line.slice(6))
}
const records=[]
for(const file of files){const expected=fs.readFileSync(path.join(extracted,file)),actual=fs.readFileSync(path.join(work,'herdr-0.9.0',file));assert.deepEqual(actual,expected,file);records.push({file,sha256:hash(actual),matchesReconstruction:true})}
fs.mkdirSync(raw,{recursive:true});fs.writeFileSync(path.join(raw,'source-reconstruction-final.json'),JSON.stringify({source,records},null,2)+'\n');console.log(`${records.length} patched files match pinned archive + committed patches`)
