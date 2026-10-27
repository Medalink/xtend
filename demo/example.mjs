// Runs one example from demo/examples/<id> with the real agent: fork, one-sentence change, upstream 2.0, plain git vs xtend sync.
// With no id it runs every example in parallel.
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const XTEND = path.join(here, '..', 'xtend.mjs')
const EXAMPLES = path.join(here, 'examples')
const OUT = path.join(here, '..', 'docs', 'data', 'examples')
const NOISE = /claude\.ai connectors are disabled|LF will be replaced by CRLF|CRLF will be replaced by LF/

const id = process.argv[2]
if (!id) {
  const ids = fs.readdirSync(EXAMPLES)
  const codes = await Promise.all(ids.map((x) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), x], { stdio: ['ignore', 'pipe', 'pipe'] })
    const logFile = fs.createWriteStream(path.join(os.tmpdir(), `xtend-example-${x}.log`))
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
const steps = []

function exec(cwd, cmd, args, { shell = false } = {}) {
  const t0 = Date.now()
  const r = shell
    ? spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 << 20 })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
  const out = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim() && !NOISE.test(l)).join('\n')
  return { status: r.status, out, seconds: Math.round((Date.now() - t0) / 100) / 10 }
}

function step(title, cwd, shown, run, { allowFail = false } = {}) {
  console.log(`\n[you] ${shown}`)
  const r = run()
  console.log(r.out)
  if (!allowFail) assert.equal(r.status, 0, `${shown} failed`)
  steps.push({ who: 'you', title, command: shown, output: r.out, seconds: r.seconds, status: r.status })
  return r
}

const git = (cwd, ...args) => {
  const r = exec(cwd, 'git', args)
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.out}`)
  return r.out.trim()
}
const xtend = (title, cwd, args, opts) =>
  step(title, cwd, `xtend ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`, () => exec(cwd, 'node', [XTEND, ...args]), opts)
const checkStep = (title, cwd, opts) => step(title, cwd, spec.check, () => exec(cwd, spec.check, [], { shell: true }), opts)

function place(version) {
  for (const f of git(upstream, 'ls-files').split('\n').filter(Boolean)) fs.rmSync(path.join(upstream, f))
  fs.cpSync(path.join(EXAMPLES, id, version), upstream, { recursive: true })
}

const shortstat = (cwd, a, b) => git(cwd, 'diff', '--shortstat', a, b, '--', '.', ':!.xtend')

fs.mkdirSync(upstream)
git(upstream, 'init', '-q', '-b', 'main')
place('v1')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', `${spec.name} 1.0`)
const v1 = git(upstream, 'rev-parse', 'HEAD')

fs.mkdirSync(home)
xtend('You take your own copy', home, ['get', upstream])
const cfgPath = path.join(fork, '.xtend', 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), check: spec.check }, null, 2) + '\n')
git(fork, 'commit', '-qam', 'Run the check on every change')

xtend('You make it yours', fork, [spec.change])
const divergence = shortstat(fork, v1, 'HEAD')

place('v2')
git(upstream, 'add', '-A')
git(upstream, 'commit', '-q', '-m', spec.upstream)
const upstreamChange = shortstat(upstream, v1, 'HEAD')

git(fork, 'fetch', '-q', 'upstream')
const plain = step('What plain git does with it', fork, 'git merge upstream/main', () => exec(fork, 'git', ['merge', 'upstream/main']), { allowFail: true })
const conflicted = git(fork, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
const plainCheck = checkStep('And the check after it', fork, { allowFail: true })
exec(fork, 'git', ['merge', '--abort'])

xtend('xtend merges it for you', fork, ['sync'])
checkStep('The check, on the merged code', fork)

const code = git(fork, 'ls-files').split('\n').filter(Boolean)
  .map((f) => fs.readFileSync(path.join(fork, f), 'utf8')).join('\n')
const kept = {}
for (const side of ['yours', 'upstream']) {
  kept[side] = Object.fromEntries(Object.entries(spec.kept[side]).map(([label, re]) => [label, new RegExp(re, 'm').test(code)]))
  for (const [k, v] of Object.entries(kept[side])) assert.ok(v, `merged code keeps ${side}: ${k}`)
}

const scrub = (json) => [root, root.replaceAll('\\', '/')].reduce((s, r) => s.split(JSON.stringify(r).slice(1, -1)).join('~'), json)
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, `${id}.json`), scrub(JSON.stringify({
  id,
  ...spec,
  generated: new Date().toISOString(),
  divergence,
  upstreamChange,
  plain: { status: plain.status, conflicted, checkPassed: plainCheck.status === 0 },
  kept,
  steps,
}, null, 2)) + '\n')
console.log(`\n${id} ok: ${root}`)
