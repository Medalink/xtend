let timer = createTimer('focus')
let interval = null

const $ = (id) => document.getElementById(id)

const KEYS = {
  ' ': () => toggle(),
  r: () => setMode(timer.mode),
  1: () => setMode('focus'),
  2: () => setMode('break'),
}

function render() {
  $('time').textContent = format(timer.remaining)
  $('start').textContent = timer.running ? 'Pause' : 'Start'
  $('ring').style.strokeDashoffset = progress(timer)
  document.title = `${format(timer.remaining)} · ${MODES[timer.mode].label}`
  for (const tab of document.querySelectorAll('[data-mode]')) {
    tab.classList.toggle('active', tab.dataset.mode === timer.mode)
    tab.setAttribute('aria-pressed', tab.dataset.mode === timer.mode)
  }
}

function setMode(mode) {
  clearInterval(interval)
  timer = createTimer(mode)
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
  if (timer.done) setMode(timer.mode === 'focus' ? 'break' : 'focus')
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
$('reset').addEventListener('click', () => setMode(timer.mode))
for (const tab of document.querySelectorAll('[data-mode]')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode))
}
document.addEventListener('keydown', onKey)
render()
