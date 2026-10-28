let timer = createTimer('focus')
let interval = null

const $ = (id) => document.getElementById(id)

function render() {
  $('time').textContent = format(timer.remaining)
  $('start').textContent = timer.running ? 'Pause' : 'Start'
  document.title = `${format(timer.remaining)} · pomo`
  for (const tab of document.querySelectorAll('[data-mode]')) {
    tab.classList.toggle('active', tab.dataset.mode === timer.mode)
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

$('start').addEventListener('click', toggle)
$('reset').addEventListener('click', () => setMode(timer.mode))
for (const tab of document.querySelectorAll('[data-mode]')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode))
}
render()
