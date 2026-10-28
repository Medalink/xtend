let timer = createTimer('focus')
let interval = null

const $ = (id) => document.getElementById(id)

function render() {
  $('time').textContent = format(timer.remaining)
  $('ring').style.strokeDashoffset = 1 - progress(timer)
  $('start').textContent = timer.running ? 'Pause' : 'Start'
  document.title = `${format(timer.remaining)} · pomo`
  for (const tab of document.querySelectorAll('[data-mode]')) {
    const active = tab.dataset.mode === timer.mode
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-pressed', active)
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

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
  const mode = Object.keys(MODES)[Number(e.key) - 1]
  if (e.key === ' ') toggle()
  else if (e.key === 'r' || e.key === 'R') setMode(timer.mode)
  else if (mode) setMode(mode)
  else return
  e.preventDefault()
}

$('start').addEventListener('click', toggle)
$('reset').addEventListener('click', () => setMode(timer.mode))
for (const tab of document.querySelectorAll('[data-mode]')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode))
}
document.addEventListener('keydown', onKey)
render()
