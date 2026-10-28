import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const XTEND = path.join(here, '..', 'xtend.mjs')
const DOCS = path.join(here, '..', 'docs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtend-demo-'))
const upstream = path.join(root, 'pomo')
const home = path.join(root, 'you')
const fork = path.join(home, 'pomo')

const REDESIGN = `Redesign pomo into a dark, distraction-free focus app. Replace the light card with a full-screen dark layout and a large circular SVG progress ring around the time. Rename the modes to "Deep work" (50 minutes) and "Recharge" (10 minutes). Add keyboard shortcuts: Space starts or pauses, R resets, 1 and 2 switch modes. Move all DOM and rendering code out of app.js into a new ui.js and delete app.js.`

const WANTED = 'Accessibility fixes are welcome, especially for screen readers.'
const A11Y = 'Announce the current mode and the end of each session to screen readers with an aria-live region.'

const NOISE =/claude\.ai connectors are disabled|LF will be replaced by CRLF/
const steps = []
const scrub = (json) => [root, root.replaceAll('\\', '/')].reduce((s, r) => s.split(JSON.stringify(r).slice(1, -1)).join('~'), json)

function exec(cwd, cmd, args, env = {}) {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 })
  const out = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim() && !NOISE.test(l)).join('\n')
  return { status: r.status, out, seconds: Math.round((Date.now() - t0) / 100) / 10 }
}

function step(who, title, cwd, shown, cmd, args, { allowFail = false } = {}) {
  console.log(`\n[${who}] ${shown}`)
  const r = exec(cwd, cmd, args)
  console.log(r.out)
  if (!allowFail) assert.equal(r.status, 0, `${shown} failed`)
  steps.push({ who, title, command: shown, output: r.out, seconds: r.seconds, status: r.status })
  return r
}

const git = (cwd, ...args) => {
  const r = exec(cwd, 'git', args)
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.out}`)
  return r.out.trim()
}
const xtend = (who, title, cwd, args, opts) =>
  step(who, title, cwd, `xtend ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, 'node', [XTEND, ...args], opts)

function copyApp(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  for (const f of fs.readdirSync(from)) {
    if (f.startsWith('.') || f === 'XTEND.md' || f === 'test.js' || f === 'package.json') continue
    fs.copyFileSync(path.join(from, f), path.join(to, f))
  }
}

function place(version) {
  for (const f of fs.readdirSync(upstream)) if (!f.startsWith('.') && f !== 'XTEND.md') fs.rmSync(path.join(upstream, f))
  for (const f of fs.readdirSync(path.join(here, version))) fs.copyFileSync(path.join(here, version, f), path.join(upstream, f))
}

const shortstat = (cwd, a, b) => git(cwd, 'diff', '--shortstat', a, b, '--', '.', ':!.xtend', ':!XTEND.md')

fs.mkdirSync(upstream)
git(upstream, 'init', '-q', '-b', 'main')
place('pomo-v1')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', 'pomo 1.0')
const v1 = git(upstream, 'rev-parse', 'HEAD')
copyApp(upstream, path.join(DOCS, 'states', '1-upstream'))

xtend('owner', 'The owner writes a ref sheet once', upstream, ['sheet'])
fs.appendFileSync(path.join(upstream, 'XTEND.md'), `${WANTED}\n`)
git(upstream, 'add', 'XTEND.md')
git(upstream, 'commit', '-q', '-m', 'Add XTEND.md')

fs.mkdirSync(home)
xtend('you', 'You take your own copy', home, ['get', upstream])
const cfgPath = path.join(fork, '.xtend', 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), check: 'node test.js' }, null, 2) + '\n')
git(fork, 'commit', '-qam', 'Run the tests on every change')

xtend('you', 'You make it yours', fork, [REDESIGN])
copyApp(fork, path.join(DOCS, 'states', '2-yours'))
const divergence = shortstat(fork, v1, 'HEAD')
const forkFiles = git(fork, 'diff', '--name-status', v1, 'HEAD', '--', '.', ':!.xtend', ':!XTEND.md')

place('pomo-v2')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', 'Long breaks every 4 sessions, session dots, chime; rename modes to presets')
copyApp(upstream, path.join(DOCS, 'states', '3-upstream-v2'))
const upstreamChange = shortstat(upstream, v1, 'HEAD')

git(fork, 'fetch', '-q', 'upstream')
const plain = step('you', 'What plain git does with it', fork, 'git merge upstream/main', 'git', ['merge', 'upstream/main'], { allowFail: true })
const conflicted = git(fork, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
const markers = exec(fork, 'git', ['grep', '-c', '^<<<<<<< ']).out
const plainTests = step('you', 'And the tests after it', fork, 'node test.js', 'node', ['test.js'], { allowFail: true })
git(fork, 'merge', '--abort')

xtend('you', 'xtend merges it for you', fork, ['sync'])
copyApp(fork, path.join(DOCS, 'states', '4-synced'))
step('you', 'Upstream tests and yours, on the merged code', fork, 'node test.js', 'node', ['test.js'])
xtend('you', 'And again tomorrow', fork, ['sync'])

const merged = (f) => (fs.existsSync(path.join(fork, f)) ? fs.readFileSync(path.join(fork, f), 'utf8') : '')
const code = ['timer.js', 'ui.js', 'index.html', 'style.css'].map(merged).join('\n')
const kept = {
  'Deep work 50 min': /50/.test(code) && /Deep work/i.test(code),
  'progress ring': /<circle|createElementNS/.test(code),
  'keyboard shortcuts': /keydown/.test(code),
  'app.js stays deleted': !fs.existsSync(path.join(fork, 'app.js')),
  'long break every 4': /SESSIONS_PER_LONG_BREAK/.test(code) && /nextPreset/.test(code),
  'session dots': /sessions/.test(code),
  chime: /AudioContext/.test(code),
}
for (const [k, v] of Object.entries(kept)) assert.ok(v, `merged code keeps: ${k}`)
const mergedTests = merged('test.js')
for (const line of fs.readFileSync(path.join(here, 'pomo-v2', 'test.js'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('assert'))) {
  assert.ok(mergedTests.includes(line), `upstream test survives the merge unedited: ${line}`)
}

xtend('you', 'A small fix the owner asked for', fork, [A11Y])
xtend('you', 'What upstream would take', fork, ['share'])
const offered = JSON.parse(exec(fork, 'node', [XTEND, 'share', '--json']).out).changes.find((c) => c.subject === A11Y)
xtend('you', 'Offer only that fix', fork, ['share', String(offered.n), '--yes'])
const offerFile = (f) => exec(fork, 'git', ['show', `xtend/offer:${f}`])
const offerCode = ['timer.js', 'app.js', 'index.html'].map((f) => offerFile(f).out).join('\n')
assert.match(offerCode, /aria-live/, 'the offer carries the fix')
assert.doesNotMatch(offerCode, /Deep work/i, 'the offer carries none of the redesign')
assert.equal(offerFile('ui.js').status === 0, false, 'the offer keeps upstream app.js layout')
const offerTree = path.join(root, 'offer')
git(fork, 'worktree', 'add', '-q', offerTree, 'xtend/offer')
assert.equal(exec(offerTree, 'node', ['test.js']).status, 0, 'upstream tests pass on the offer')
const offer = {
  files: git(fork, 'diff', '--stat', 'upstream/main', 'xtend/offer'),
  body: fs.readFileSync(path.join(fork, '.git', 'xtend-offer.md'), 'utf8'),
}

const result = {
  generated: new Date().toISOString(),
  agent: JSON.parse(fs.readFileSync(cfgPath, 'utf8')).agent,
  redesign: REDESIGN,
  divergence,
  forkFiles,
  upstreamChange,
  plain: { status: plain.status, conflicted, markers, testsPassed: plainTests.status === 0 },
  kept,
  log: git(fork, 'log', '--graph', '--format=%s', '-n', '12'),
  steps,
  sheet: fs.readFileSync(path.join(upstream, 'XTEND.md'), 'utf8'),
  wanted: WANTED,
  offer,
}
fs.mkdirSync(path.join(DOCS, 'data'), { recursive: true })
fs.writeFileSync(path.join(DOCS, 'data', 'demo.json'), scrub(JSON.stringify(result, null, 2)) + '\n')
console.log(`\ndemo ok: ${root}`)
console.log(JSON.stringify({ divergence, upstreamChange, conflicted, kept }, null, 2))
