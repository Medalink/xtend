const MODES = {
  focus: { label: 'Deep work', minutes: 50 },
  break: { label: 'Recharge', minutes: 10 },
}

function createTimer(mode = 'focus') {
  return { mode, remaining: MODES[mode].minutes * 60, running: false, done: false }
}

function tick(t) {
  if (!t.running) return t
  const remaining = Math.max(0, t.remaining - 1)
  return remaining === 0 ? { ...t, remaining, running: false, done: true } : { ...t, remaining }
}

function format(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return `${m}:${s}`
}

function progress(t) {
  return t.remaining / (MODES[t.mode].minutes * 60)
}

if (typeof module !== 'undefined') module.exports = { MODES, createTimer, tick, format, progress }
