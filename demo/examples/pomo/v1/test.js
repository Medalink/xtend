const assert = require('node:assert/strict')
const { MODES, createTimer, tick, format } = require('./timer.js')

assert.equal(format(1500), '25:00')
assert.equal(format(65), '01:05')

const t = createTimer('focus')
assert.equal(t.remaining, MODES.focus.minutes * 60)
assert.equal(tick(t), t, 'paused timer does not move')

let running = { ...t, running: true, remaining: 2 }
running = tick(running)
assert.equal(running.remaining, 1)
running = tick(running)
assert.equal(running.done, true)
assert.equal(running.running, false)

console.log('ok')
