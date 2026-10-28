// Runs one app from demo/examples/<id> with the real agent, start to finish: the owner's sheet, a fork,
// a one-sentence change, upstream 2.0, plain git vs xtend sync, and offering a fix back.
// With no id it runs every app in parallel. Writes docs/data/apps/<id>.json, and docs/states/<id> for web apps.
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const XTEND = path.join(here, '..', 'xtend.mjs')
const EXAMPLES = path.join(here, 'examples')
const DOCS = path.join(here, '..', 'docs')
const NOISE = /claude\.ai connectors are disabled|LF will be replaced by CRLF|CRLF will be replaced by LF/
const STATES = ['upstream1', 'yours', 'upstream2', 'synced']
const OURS = ['.', ':!.xtend', ':!XTEND.md']

const id = process.argv[2]
if (!id) {
  const ids = fs.readdirSync(EXAMPLES)
  const codes = await Promise.all(ids.map((x) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), x], { stdio: ['ignore', 'pipe', 'pipe'] })
    const logFile = fs.createWriteStream(path.join(os.tmpdir(), `xtend-run-${x}.log`))
    child.stdout.pipe(logFile), child.stderr.pipe(logFile)
    child.on('close', (code) => { console.log(`${x}: ${code === 0 ? 'ok' : `failed (${code}), see ${logFile.path}`}`); done(code) })
  })))
  process.exit(codes.some(Boolean) ? 1 : 0)
}

const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, id, 'example.json'), 'utf8'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), `xtend-${id}-`))
const upstream = path.join(root, spec.name)
const home = path.join(root, 'you')
const fork = path.join(home, spec.name)
const sample = path.join(root, 'sample.txt')
if (spec.sample) fs.writeFileSync(sample, spec.sample)
const steps = []

function exec(cwd, cmd, args, { shell = false, env = {} } = {}) {
  const t0 = Date.now()
  const opts = { cwd, shell, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 }
  const r = shell ? spawnSync(cmd, opts) : spawnSync(cmd, args, opts)
  const clean = (s) => s.split('\n').filter((l) => l.trim() && !NOISE.test(l)).join('\n')
  return { status: r.status, out: clean(`${r.stdout}${r.stderr}`), stdout: clean(r.stdout), seconds: Math.round((Date.now() - t0) / 100) / 10 }
}

function step(who, title, cwd, shown, run, { allowFail = false } = {}) {
  console.log(`\n[${who}] ${shown}`)
  const r = run()
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
  step(who, title, cwd, `xtend ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, () => exec(cwd, 'node', [XTEND, ...args]), opts)
const shell = (cwd, cmd) => exec(cwd, cmd.replaceAll('{sample}', JSON.stringify(sample)), [], { shell: true, env: { HABITS_FILE: path.join(fs.mkdtempSync(path.join(root, 'store-')), 'habits.json') } })
const checkStep = (title, cwd, opts) => step('you', title, cwd, spec.check, () => shell(cwd, spec.check), opts)

function place(version) {
  for (const f of git(upstream, 'ls-files').split('\n').filter((f) => f && f !== 'XTEND.md')) fs.rmSync(path.join(upstream, f))
  fs.cpSync(path.join(EXAMPLES, id, version), upstream, { recursive: true })
}

// Every file either side touched, with lines added and removed.
function files(cwd, a, b) {
  const status = Object.fromEntries(git(cwd, 'diff', '--name-status', '--no-renames', a, b, '--', ...OURS).split('\n').filter(Boolean).map((l) => l.split('\t').reverse()))
  return git(cwd, 'diff', '--numstat', '--no-renames', a, b, '--', ...OURS).split('\n').filter(Boolean).map((l) => {
    const [add, del, file] = l.split('\t')
    return { file, status: status[file], add: Number(add) || 0, del: Number(del) || 0 }
  })
}

const screens = {}
function screen(state, cwd) {
  if (spec.web) {
    const to = path.join(DOCS, 'states', id, state)
    fs.rmSync(to, { recursive: true, force: true })
    fs.mkdirSync(to, { recursive: true })
    for (const f of git(cwd, 'ls-files').split('\n')) if (/\.(html|css|js)$/.test(f) && f !== spec.tests?.file) fs.copyFileSync(path.join(cwd, f), path.join(to, f))
    return (screens[state] = { href: `states/${id}/${state}/index.html` })
  }
  const command = spec.screens[state] || spec.screens.cmd
  const r = shell(cwd, command)
  assert.equal(r.status, 0, `${command} on ${state}\n${r.out}`)
  screens[state] = { command: command.replaceAll('{sample}', 'app.log'), output: r.stdout }
}

const code = (cwd, ref) => git(cwd, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)
  .map((f) => exec(cwd, 'git', ['show', `${ref}:${f}`]).stdout).join('\n')

fs.mkdirSync(upstream)
git(upstream, 'init', '-q', '-b', 'main')
place('v1')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', `${spec.name} 1.0`)
const v1 = git(upstream, 'rev-parse', 'HEAD')
screen('upstream1', upstream)

xtend('owner', 'The owner writes a ref sheet once', upstream, ['sheet'])
fs.appendFileSync(path.join(upstream, 'XTEND.md'), `${spec.wanted}\n`)
git(upstream, 'add', 'XTEND.md')
git(upstream, 'commit', '-q', '-m', 'Add XTEND.md')

fs.mkdirSync(home)
xtend('you', 'You take your own copy', home, ['get', upstream])
const cfgPath = path.join(fork, '.xtend', 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), check: spec.check }, null, 2) + '\n')
git(fork, 'commit', '-qam', 'Run the check on every change')

xtend('you', 'You make it yours', fork, [spec.change])
screen('yours', fork)
const yours = files(fork, v1, 'HEAD')

place('v2')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', spec.upstream)
screen('upstream2', upstream)
const theirs = files(upstream, v1, 'HEAD')

git(fork, 'fetch', '-q', 'upstream')
const plain = step('you', 'What plain git does with it', fork, 'git merge upstream/main', () => exec(fork, 'git', ['merge', 'upstream/main']), { allowFail: true })
const conflicted = git(fork, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
const plainCheck = checkStep('And the check after it', fork, { allowFail: true })
exec(fork, 'git', ['merge', '--abort'])
assert.ok(conflicted.length, 'plain git conflicts')

const synced = xtend('you', 'xtend merges it for you', fork, ['sync'])
checkStep('The check, on the merged code', fork)
screen('synced', fork)
xtend('you', 'And again tomorrow', fork, ['sync'])

// Throw the merge away and do it again: git remembers every resolution, so the agent has nothing to do.
const mergedTree = git(fork, 'rev-parse', 'HEAD^{tree}')
step('you', 'Throw the merge away', fork, 'git switch -c again HEAD^1', () => exec(fork, 'git', ['switch', '-c', 'again', 'HEAD^1']))
const again = xtend('you', 'Merge it again from scratch', fork, ['sync'])
const replay = {
  seconds: again.seconds,
  output: again.out,
  agent: /asking agent/.test(again.out),
  sameTree: git(fork, 'rev-parse', 'HEAD^{tree}') === mergedTree,
}
git(fork, 'switch', '-q', 'main')
git(fork, 'branch', '-q', '-D', 'again')

const merged = code(fork, 'HEAD')
const kept = {}
for (const side of ['yours', 'upstream']) {
  kept[side] = Object.fromEntries(Object.entries(spec.kept[side]).map(([label, re]) => [label, new RegExp(re, 'm').test(merged)]))
  for (const [k, v] of Object.entries(kept[side])) assert.ok(v, `merged code keeps ${side}: ${k}`)
}
for (const f of spec.gone || []) assert.ok(!fs.existsSync(path.join(fork, f)), `${f} stays deleted`)
if (spec.tests) {
  const tests = fs.readFileSync(path.join(fork, spec.tests.file), 'utf8')
  for (const line of fs.readFileSync(path.join(EXAMPLES, id, 'v2', spec.tests.file), 'utf8').split(/\r?\n/).filter((l) => new RegExp(spec.tests.lines).test(l))) {
    assert.ok(tests.includes(line), `upstream test survives the merge unedited: ${line}`)
  }
}

xtend('you', 'A small fix the owner asked for', fork, [spec.fix])
const preview = xtend('you', 'What upstream would take', fork, ['share'])
const offered = JSON.parse(exec(fork, 'node', [XTEND, 'share', '--json']).out).changes.find((c) => c.subject === spec.fix)
xtend('you', 'Offer only that fix', fork, ['share', String(offered.n), '--yes'])

const offerTree = path.join(root, 'offer')
git(fork, 'worktree', 'add', '-q', offerTree, 'xtend/offer')
assert.equal(shell(offerTree, spec.check).status, 0, 'upstream check passes on the offer')
const offerCode = code(fork, 'xtend/offer')
const probe = spec.offer.run && shell(offerTree, spec.offer.run)
assert.match(probe ? probe.out : offerCode, new RegExp(spec.offer.has), 'the offer carries the fix')
for (const [label, re] of Object.entries(spec.kept.yours)) assert.doesNotMatch(offerCode, new RegExp(re, 'm'), `the offer leaves out your ${label}`)
for (const f of spec.gone || []) assert.equal(exec(fork, 'git', ['cat-file', '-e', `xtend/offer:${f}`]).status, 0, `the offer keeps upstream's ${f}`)

const scrub = (json) => [root, root.replaceAll('\\', '/')].reduce((s, r) => s.split(JSON.stringify(r).slice(1, -1)).join('~'), json)
fs.mkdirSync(path.join(DOCS, 'data', 'apps'), { recursive: true })
fs.writeFileSync(path.join(DOCS, 'data', 'apps', `${id}.json`), scrub(JSON.stringify({
  id,
  name: spec.name,
  lang: spec.lang,
  about: spec.about,
  check: spec.check,
  change: spec.change,
  upstream: spec.upstream,
  wanted: spec.wanted,
  fix: spec.fix,
  web: !!spec.web,
  generated: new Date().toISOString(),
  agent: JSON.parse(fs.readFileSync(cfgPath, 'utf8')).agent,
  files: { yours, theirs, conflicted },
  plain: { status: plain.status, checkPassed: plainCheck.status === 0, check: plainCheck.out },
  sync: { seconds: synced.seconds, output: synced.out },
  replay,
  kept,
  screens,
  log: git(fork, 'log', '--graph', '--format=%s', '-n', '12'),
  sheet: fs.readFileSync(path.join(upstream, 'XTEND.md'), 'utf8'),
  share: preview.out,
  offer: {
    files: files(fork, 'upstream/main', 'xtend/offer'),
    body: fs.readFileSync(path.join(fork, '.git', 'xtend-offer.md'), 'utf8'),
    probe: probe ? { command: spec.offer.run.replaceAll('{sample}', 'app.log'), output: probe.out } : null,
  },
  steps,
}, null, 2)) + '\n')
console.log(`\n${id} ok: ${root}`)
