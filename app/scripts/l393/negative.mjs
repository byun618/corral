// Deliberately exits nonzero. Reviewers must observe failure rather than a fabricated pass.
import {until} from './lib.mjs'
await until(()=>false,'intentional never-satisfied condition',50)
console.log('UNEXPECTED: the negative control reached success')
