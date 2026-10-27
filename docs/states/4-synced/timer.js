const PRESETS = {
  focus: { label: 'Deep work', minutes: 50 },
  short: { label: 'Recharge', minutes: 10 },
  long: { label: 'Long recharge', minutes: 15 },
}

const SESSIONS_PER_LONG_BREAK = 4

function createTimer(preset = 'focus', completed = 0) {
  return { preset, completed, remaining: PRESETS[preset].minutes * 60, running: false, done: false }
}

function tick(t) {
  if (!t.running) return t
  const remaining = Math.max(0, t.remaining - 1)
  if (remaining > 0) return { ...t, remaining }
  const completed = t.preset === 'focus' ? t.completed + 1 : t.completed
  return { ...t, remaining, completed, running: false, done: true }
}

function nextPreset(t) {
  if (t.preset !== 'focus') return 'focus'
  return t.completed % SESSIONS_PER_LONG_BREAK === 0 ? 'long' : 'short'
}

function format(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return `${m}:${s}`
}

if (typeof module !== 'undefined') {
  module.exports = { PRESETS, SESSIONS_PER_LONG_BREAK, createTimer, tick, nextPreset, format }
}
