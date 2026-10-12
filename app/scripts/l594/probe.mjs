import { connect } from './cdp.mjs'
const c = await connect(); const code = process.argv[2]
console.log(JSON.stringify(await c.evaluate(code), null, 1)); c.close()
