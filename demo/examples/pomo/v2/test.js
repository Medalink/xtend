const assert = require('node:assert/strict')
const { PRESETS, SESSIONS_PER_LONG_BREAK, createTimer, tick, nextPreset, format } = require('./timer.js')

assert.equal(format(1500), '25:00')
assert.equal(format(65), '01:05')

const t = createTimer('focus')
assert.equal(t.remaining, PRESETS.focus.minutes * 60)
assert.equal(tick(t), t, 'paused timer does not move')

let running = { ...t, running: true, remaining: 2 }
running = tick(running)
assert.equal(running.remaining, 1)
running = tick(running)
assert.equal(running.done, true)
assert.equal(running.running, false)
assert.equal(running.completed, 1, 'finishing focus counts a session')

const finish = (timer) => tick({ ...timer, running: true, remaining: 1 })
let day = createTimer('focus')
const seen = []
for (let i = 0; i < SESSIONS_PER_LONG_BREAK * 2; i++) {
  day = finish(day)
  const next = nextPreset(day)
  seen.push(next)
  day = createTimer(next, day.completed)
}
assert.deepEqual(seen, ['short', 'focus', 'short', 'focus', 'short', 'focus', 'long', 'focus'])
assert.equal(day.completed, SESSIONS_PER_LONG_BREAK)
assert.equal(finish(createTimer('short', 2)).completed, 2, 'breaks do not count')

console.log('ok')
