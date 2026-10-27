import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const XTEND = path.join(here, '..', 'xtend.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtend-e2e-'))
const agentLog = path.join(root, 'agent.log')
const env = { ...process.env, XTEND_AGENT: `node "${path.join(here, 'fake-agent.mjs')}"`, FAKE_LOG: agentLog }

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const xtend = (cwd, args, extra = {}) =>
  spawnSync('node', [XTEND, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } })
const agentCalls = () => (fs.existsSync(agentLog) ? fs.readFileSync(agentLog, 'utf8').trim().split('\n').length : 0)

const up = path.join(root, 'app')
fs.mkdirSync(up)
git(up, 'init', '-q', '-b', 'main')
git(up, 'config', 'user.email', 'o@x'), git(up, 'config', 'user.name', 'owner')
const commitUp = (file, body, msg) => {
  fs.writeFileSync(path.join(up, file), body)
  git(up, 'add', '-A'), git(up, 'commit', '-q', '-m', msg)
}
commitUp('app.js', "const greeting = 'hello'\n// a\n// b\nconst name = 'world'\nconsole.log(greeting, name)\n", 'initial')

const work = path.join(root, 'mine')
fs.mkdirSync(work)
let r = xtend(work, ['get', up])
assert.equal(r.status, 0, r.stderr)
const fork = path.join(work, 'app')
assert.ok(fs.existsSync(path.join(fork, '.xtend/sheet.md')), 'get wrote the ref sheet')
assert.ok(fs.existsSync(path.join(fork, '.xtend/xtend.mjs')), 'get vendored xtend')
assert.ok(!fs.existsSync(path.join(fork, '.github')), 'no workflow without a GitHub fork')
git(fork, 'config', 'user.email', 'u@x'), git(fork, 'config', 'user.name', 'user')

const cfgPath = path.join(fork, '.xtend/config.json')
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath)), check: 'node app.js' }))
git(fork, 'commit', '-qam', 'run app as check')

const beforeChange = git(fork, 'rev-parse', 'HEAD')
r = xtend(fork, ['make', 'it', 'say', 'howdy'], { FAKE_MODE: 'commit' })
assert.equal(r.status, 0, r.stderr)
assert.match(git(fork, 'log', '-1', '--format=%B'), /xtend: make it say howdy[\s\S]*howdy/, 'change commit records intent')
assert.equal(git(fork, 'rev-parse', 'HEAD~1'), beforeChange, 'an agent that commits itself is folded into one xtend commit')

commitUp('app.js', "const greeting = 'hello there'\n// a\n// b\nconst name = 'everyone'\nconsole.log(greeting, name)\n", 'friendlier, wider')
r = xtend(fork, ['sync'])
assert.equal(r.status, 0, r.stderr + r.stdout)
const merged = fs.readFileSync(path.join(fork, 'app.js'), 'utf8')
assert.match(merged, /howdy/, 'local intent survives')
assert.match(merged, /everyone/, 'upstream change lands')
assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/, 'no markers')
assert.equal(git(fork, 'log', '-1', '--format=%P').split(' ').length, 2, 'sync made a merge commit')

const calls = agentCalls()
r = xtend(fork, ['sync'])
assert.match(r.stdout, /already up to date/, 'second sync is a no-op')
assert.equal(agentCalls(), calls, 'no-op sync never calls the agent')

commitUp('README.md', '# app\n', 'add readme')
r = xtend(fork, ['sync'])
assert.match(r.stdout, /merged upstream cleanly/, r.stderr)
assert.equal(agentCalls(), calls, 'clean merge never calls the agent')

const head = git(fork, 'rev-parse', 'HEAD')
commitUp('app.js', "const greeting = 'yo'\n// a\n// b\nconst name = 'everyone'\nconsole.log(greeting, name)\n", 'yo')
r = xtend(fork, ['sync'], { FAKE_MODE: 'fail' })
assert.equal(r.status, 1, 'failed sync exits nonzero')
assert.match(r.stderr, /gave up/)
assert.equal(git(fork, 'rev-parse', 'HEAD'), head, 'failed sync leaves HEAD alone')
assert.equal(git(fork, 'status', '--porcelain'), '', 'failed sync leaves a clean tree')

r = xtend(fork, ['sync'], { FAKE_MODE: 'half' })
assert.equal(r.status, 1, 'a leftover ======= line fails the sync')
assert.equal(git(fork, 'rev-parse', 'HEAD'), head, 'half-resolved sync leaves HEAD alone')

git(fork, 'config', 'status.showUntrackedFiles', 'no')
fs.writeFileSync(path.join(fork, 'notes.txt'), 'mine')
r = xtend(fork, ['sync'], { FAKE_MODE: 'fail' })
assert.match(r.stderr, /uncommitted changes/, 'hidden untracked files still block a sync')
assert.ok(fs.existsSync(path.join(fork, 'notes.txt')), 'untracked file survives')
fs.rmSync(path.join(fork, 'notes.txt'))

r = xtend(fork, ['sync'])
assert.equal(r.status, 0, 'retry after failure succeeds')
assert.match(fs.readFileSync(path.join(fork, 'app.js'), 'utf8'), /howdy/)

r = xtend(fork, ['add', 'a', 'footer'], { FAKE_MODE: 'hook' })
assert.equal(r.status, 1, 'an agent that writes a git hook is stopped')
assert.match(r.stdout, /restored/)
assert.ok(!fs.existsSync(path.join(fork, '.git/hooks/pre-commit')), 'the planted hook is removed')

const synced = git(fork, 'rev-parse', 'HEAD')
fs.writeFileSync(path.join(fork, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
commitUp('NOTES.md', 'notes\n', 'add notes')
r = xtend(fork, ['sync'])
assert.equal(r.status, 1, 'a failing commit hook fails the sync')
assert.equal(git(fork, 'rev-parse', 'HEAD'), synced, 'failed commit leaves HEAD alone')
assert.ok(!fs.existsSync(path.join(fork, '.git/MERGE_HEAD')), 'failed commit leaves no merge in progress')
fs.rmSync(path.join(fork, '.git/hooks/pre-commit'))

git(fork, 'remote', 'add', 'origin', path.join(root, 'no-such-remote'))
r = xtend(fork, ['sync'])
assert.match(r.stdout, /merged upstream cleanly/)
assert.equal(r.status, 1, 'a failed push exits non-zero')
git(fork, 'remote', 'remove', 'origin')

fs.rmSync(root, { recursive: true, force: true })
console.log('e2e ok')
