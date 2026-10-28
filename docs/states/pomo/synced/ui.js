let timer = createTimer('focus')
let interval = null

const $ = (id) => document.getElementById(id)

const KEYS = {
  ' ': () => toggle(),
  r: () => setPreset(timer.preset),
  1: () => setPreset('focus'),
  2: () => setPreset('short'),
  3: () => setPreset('long'),
}

function chime() {
  const ctx = new AudioContext()
  for (const [i, freq] of [660, 880].entries()) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.25)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.6)
    osc.connect(gain).connect(ctx.destination)
    osc.start(ctx.currentTime + i * 0.25)
    osc.stop(ctx.currentTime + i * 0.25 + 0.6)
  }
}

function renderSessions() {
  const done = timer.completed % SESSIONS_PER_LONG_BREAK
  $('sessions').innerHTML = Array.from({ length: SESSIONS_PER_LONG_BREAK }, (_, i) =>
    `<span class="dot${i < done ? ' filled' : ''}"></span>`).join('')
  $('count').textContent = `${timer.completed} done today`
}

function render() {
  $('time').textContent = format(timer.remaining)
  $('start').textContent = timer.running ? 'Pause' : 'Start'
  $('ring').style.strokeDashoffset = progress(timer)
  document.title = `${format(timer.remaining)} · ${PRESETS[timer.preset].label}`
  for (const tab of document.querySelectorAll('[data-preset]')) {
    tab.classList.toggle('active', tab.dataset.preset === timer.preset)
    tab.setAttribute('aria-pressed', tab.dataset.preset === timer.preset)
  }
  renderSessions()
}

function setPreset(preset) {
  clearInterval(interval)
  timer = createTimer(preset, timer.completed)
  render()
}

function toggle() {
  timer = { ...timer, running: !timer.running }
  clearInterval(interval)
  if (timer.running) interval = setInterval(step, 1000)
  render()
}

function step() {
  timer = tick(timer)
  if (timer.done) {
    chime()
    setPreset(nextPreset(timer))
  }
  render()
}

function onKey(event) {
  const action = KEYS[event.key.toLowerCase()]
  if (!action || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
  // Stops Space from also clicking a focused button.
  event.preventDefault()
  action()
}

$('start').addEventListener('click', toggle)
$('reset').addEventListener('click', () => setPreset(timer.preset))
for (const tab of document.querySelectorAll('[data-preset]')) {
  tab.addEventListener('click', () => setPreset(tab.dataset.preset))
}
document.addEventListener('keydown', onKey)
render()
