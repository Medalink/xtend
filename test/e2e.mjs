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
const env = { ...process.env, XTEND_AGENT: `node "${path.join(here, 'fake-agent.mjs')}"`, FAKE_LOG: agentLog, XTEND_CONFIG_DIR: path.join(root, 'device') }

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
assert.ok(!fs.existsSync(path.join(fork, '.github')), 'daily sync is opt-in')
assert.match(r.stdout, /xtend daily on/, 'get says how to turn daily sync on')
assert.match(xtend(fork, ['daily']).stdout, /daily sync: off/)
r = xtend(fork, ['daily', 'on'])
assert.match(r.stderr, /no origin/, 'daily sync needs a fork to run in')
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

let calls = agentCalls()
r = xtend(fork, ['sync'])
assert.match(r.stdout, /already up to date/, 'second sync is a no-op')
assert.equal(agentCalls(), calls, 'no-op sync never calls the agent')

const rrCache = path.join(fork, '.git/rr-cache')
const firstMerge = git(fork, 'rev-parse', 'HEAD')
git(fork, 'reset', '-q', '--hard', 'HEAD^1')
r = xtend(fork, ['sync'])
assert.equal(r.status, 0, r.stderr + r.stdout)
assert.match(r.stdout, /reused 1 resolution git remembered: app\.js/)
assert.equal(agentCalls(), calls, 'a conflict git has seen before never calls the agent')
assert.equal(git(fork, 'rev-parse', 'HEAD^{tree}'), git(fork, 'rev-parse', `${firstMerge}^{tree}`), 'the replay gives the same merge')

git(fork, 'reset', '-q', '--hard', 'HEAD^1')
for (const id of fs.readdirSync(rrCache)) fs.writeFileSync(path.join(rrCache, id, 'postimage'), 'syntax error(\n')
r = xtend(fork, ['sync'])
assert.equal(r.status, 0, r.stderr + r.stdout)
assert.equal(agentCalls(), calls + 1, 'a remembered resolution that fails the check goes to the agent')
assert.match(r.stdout, /agent resolved: app\.js; git forgot/)
assert.match(fs.readFileSync(path.join(fork, 'app.js'), 'utf8'), /howdy[\s\S]*everyone/)
assert.ok(!fs.existsSync(rrCache) || fs.readdirSync(rrCache).every((id) => !/syntax error/.test(fs.readFileSync(path.join(rrCache, id, 'postimage'), 'utf8'))), 'the bad resolution is forgotten')
calls = agentCalls()

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

const fake = `node "${path.join(here, 'fake-agent.mjs')}"`
const savedAgent = { XTEND_AGENT: '' }
r = xtend(fork, ['agent', 'codex', '-m', 'gpt-x'], savedAgent)
assert.equal(r.status, 0, r.stderr)
assert.equal(JSON.parse(fs.readFileSync(cfgPath)).agent, 'codex exec -s workspace-write - -m gpt-x', 'a preset plus your own flags')
r = xtend(fork, ['agent'], savedAgent)
assert.match(r.stdout, /agent: codex exec/, 'xtend agent shows the current agent')
r = xtend(fork, ['agent', `${fake} --file {file}`], savedAgent)
assert.equal(JSON.parse(fs.readFileSync(cfgPath)).agent, `${fake} --file {file}`, 'any command can be the agent')
r = xtend(fork, ['say', 'howdy', 'twice'], { ...savedAgent, FAKE_MODE: 'append' })
assert.equal(r.status, 0, `an agent that reads the prompt from {file} works: ${r.stderr}`)
assert.match(git(fork, 'log', '-1', '--format=%s'), /xtend: say howdy twice/)
assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xtend-') && fs.existsSync(path.join(os.tmpdir(), f, 'prompt.md'))).length, 0, 'the prompt file is cleaned up')

let synced = git(fork, 'rev-parse', 'HEAD')
r = xtend(fork, ['add', 'a', 'footer'], { FAKE_MODE: 'hook' })
assert.equal(r.status, 1, 'an agent that writes a git hook is stopped')
assert.match(r.stdout, /restored/)
assert.ok(!fs.existsSync(path.join(fork, '.git/hooks/pre-commit')), 'the planted hook is removed')
assert.equal(git(fork, 'rev-parse', 'HEAD'), synced, 'the agent commit is undone even when xtend stops it')
git(fork, 'reset', '-q', '--hard')

const ran = path.join(root, 'hook-ran')
fs.writeFileSync(path.join(fork, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch "${ran.replaceAll('\\', '/')}"\nexit 1\n`, { mode: 0o755 })
commitUp('NOTES.md', 'notes\n', 'add notes')
r = xtend(fork, ['sync'])
assert.equal(r.status, 0, r.stderr)
assert.ok(!fs.existsSync(ran), 'xtend runs git with hooks off')
fs.rmSync(path.join(fork, '.git/hooks/pre-commit'))

synced = git(fork, 'rev-parse', 'HEAD')
commitUp('app.js', "const greeting = 'hiya'\n// a\n// b\nconst name = 'everyone'\nconsole.log(greeting, name)\n", 'hiya')
r = xtend(fork, ['sync'], { FAKE_MODE: 'gitdir' })
assert.equal(r.status, 1, 'an agent that rewrites git config mid-merge is stopped')
assert.equal(git(fork, 'rev-parse', 'HEAD'), synced, 'and nothing changes')
assert.ok(!fs.existsSync(path.join(fork, '.git/MERGE_HEAD')), 'and no merge is left in progress')
assert.doesNotMatch(fs.readFileSync(path.join(fork, '.git/config'), 'utf8'), /evil/, 'config is restored')
assert.ok(!fs.existsSync(path.join(fork, '.git/info/attributes')), 'attributes are restored')
assert.ok(fs.readdirSync(path.join(fork, '.git/hooks')).length > 0, 'deleted hooks come back')
r = xtend(fork, ['sync'])
assert.equal(r.status, 0, r.stderr)

git(fork, 'remote', 'add', 'origin', path.join(root, 'no-such-remote'))
commitUp('NOTES.md', 'more notes\n', 'more notes')
r = xtend(fork, ['sync'])
assert.match(r.stdout, /merged upstream cleanly/)
assert.equal(r.status, 1, 'a failed push exits non-zero')
r = xtend(fork, ['sync'])
assert.match(r.stdout, /already up to date[\s\S]*push failed/, 'the next sync retries the push')
assert.equal(r.status, 1)
git(fork, 'remote', 'remove', 'origin')

// --- share: offering changes back upstream ---
const MARK = '<!-- xtend offer -->'
const hasBranch = (cwd, b) => spawnSync('git', ['rev-parse', '--verify', '-q', b], { cwd }).status === 0
const unmoved = (head, msg) => {
  assert.equal(git(fork, 'symbolic-ref', '--short', 'HEAD'), 'main', `${msg}: back on main`)
  assert.equal(git(fork, 'rev-parse', 'HEAD'), head, `${msg}: HEAD unchanged`)
  assert.equal(git(fork, 'status', '--porcelain'), '', `${msg}: clean tree`)
}
const preview = (extra) => JSON.parse(xtend(fork, ['share', '--json'], extra).stdout)

let p = preview()
assert.equal(p.takes, 'pr')
assert.deepEqual(p.changes.map((c) => c.subject), ['make it say howdy', 'say howdy twice'], 'only your own changes are offered, not xtend setup')
assert.equal(p.changes[0].appliesCleanly, false, 'upstream moved under the change')

let mine = git(fork, 'rev-parse', 'HEAD')
r = xtend(fork, ['share', '1', '--yes'], { CI: 'true' })
assert.equal(r.status, 1)
assert.match(r.stderr, /never offers changes from CI/)
assert.ok(!hasBranch(fork, 'xtend/offer'), 'CI builds nothing')
r = xtend(fork, ['share', '1'])
assert.match(r.stderr, /--yes/, 'without a terminal, offering needs --yes')
assert.ok(!hasBranch(fork, 'xtend/offer'))

const beforePort = agentCalls()
r = xtend(fork, ['share', '1', '--yes'])
assert.equal(r.status, 0, r.stderr + r.stdout)
assert.equal(agentCalls(), beforePort, 'the port needs no agent')
assert.match(r.stdout, /reused 1 resolution git remembered for "make it say howdy": app\.js/, 'the resolution from the sync is reused for the port')
assert.match(r.stdout, /not on GitHub/)
unmoved(mine, 'offline offer')
assert.equal(git(fork, 'diff', '--name-only', 'upstream/main', 'xtend/offer'), 'app.js', 'the offer carries no xtend files')
assert.match(git(fork, 'show', 'xtend/offer:app.js'), /howdy[\s\S]*everyone/, 'ported onto the latest upstream code')
assert.match(fs.readFileSync(path.join(fork, '.git/xtend-offer.md'), 'utf8'), /git cherry-pick/)

const bare = path.join(root, 'fork.git')
git(root, 'init', '-q', '--bare', bare)
git(fork, 'remote', 'add', 'origin', 'https://github.com/me/app.git')
git(fork, 'remote', 'set-url', '--push', 'origin', bare)
fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath)), upstream: 'https://github.com/acme/app' }))
git(fork, 'commit', '-qam', 'upstream lives on GitHub')
mine = git(fork, 'rev-parse', 'HEAD')

const ghLog = path.join(root, 'gh.log')
const gh = { XTEND_GH: path.join(here, 'fake-gh.mjs'), FAKE_GH_LOG: ghLog }
const ghCalls = (verb) => fs.readFileSync(ghLog, 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.args[1] === verb)

const ported = agentCalls()
r = xtend(fork, ['share', '1', '--yes'], gh)
assert.equal(agentCalls(), ported, 'porting the same change again reuses what git remembered')
assert.match(r.stdout, /reused 1 resolution/)
assert.equal(r.status, 0, r.stderr + r.stdout)
assert.match(r.stdout, /opened https:\/\/github.com\/acme\/app\/pull\/7/)
unmoved(mine, 'GitHub offer')
const [created] = ghCalls('create')
for (const a of ['--draft', 'acme/app', 'me:xtend/offer']) assert.ok(created.args.includes(a), `pr create gets ${a}`)
for (const s of [MARK, 'git fetch https://github.com/me/app.git xtend/offer', 'git cherry-pick', 'Ported from']) assert.ok(created.input.includes(s), `offer body has ${s}`)
assert.ok(hasBranch(bare, 'xtend/offer'), 'the offer branch is pushed to your fork')

r = xtend(fork, ['share', '1', '--yes'], { ...gh, FAKE_GH_PRS: JSON.stringify([{ url: 'https://github.com/acme/app/pull/7', state: 'OPEN', body: MARK }]) })
assert.equal(agentCalls(), ported, 'updating the offer reuses it too')
assert.equal(r.status, 0, r.stderr)
assert.equal(ghCalls('create').length, 1, 'an open offer is updated, never doubled')
assert.equal(ghCalls('edit').length, 1)

const closed = { ...gh, FAKE_GH_PRS: JSON.stringify([{ url: 'u', state: 'CLOSED', body: created.input }]) }
assert.equal(preview(closed).changes[0].closedBefore, true)
r = xtend(fork, ['share', '1', '--yes'], closed)
assert.match(r.stderr, /closed an earlier offer/, 'a change the owner closed is never offered again')

const collab = { ...gh, FAKE_GH_REPO: JSON.stringify({ has_issues: true, pull_request_creation_policy: 'collaborators_only' }) }
p = preview(collab)
assert.equal(p.takes, 'issue', 'collaborator-only PRs fall back to an issue')
assert.match(p.notes.join(), /collaborators/)

git(fork, 'branch', '-D', 'xtend/offer')
const refuses = (pattern, msg) => {
  const res = xtend(fork, ['share', '1', '--yes'], gh)
  assert.equal(res.status, 1, msg)
  assert.match(res.stderr, pattern, msg)
  assert.ok(!hasBranch(fork, 'xtend/offer'), `${msg}: nothing built`)
  unmoved(mine, msg)
}

commitUp('CONTRIBUTING.md', '# Contributing\n\nSign off every commit (DCO).\n', 'contributing')
assert.equal(preview(gh).signoff, true)
refuses(/--signoff/, 'a DCO project needs your explicit --signoff')

commitUp('CONTRIBUTING.md', '# Contributing\n\nWe do not accept AI-generated pull requests.\n', 'no AI')
p = preview(gh)
assert.equal(p.takes, null)
assert.match(p.notes.join(), /CONTRIBUTING.md:3/, 'the reason quotes file and line')
refuses(/takes no changes from forks/, 'an AI ban stops the offer')

fs.rmSync(path.join(up, 'CONTRIBUTING.md'))
r = xtend(up, ['sheet'])
assert.equal(r.status, 0, r.stderr)
assert.match(fs.readFileSync(path.join(up, 'XTEND.md'), 'utf8'), /^contributions: pr$/m, 'owner sheets get a contributions line')
fs.appendFileSync(path.join(up, 'XTEND.md'), 'Bug fixes and translations.\n')
git(up, 'add', '-A'), git(up, 'commit', '-qm', 'owner sheet')
p = preview(gh)
assert.equal(p.takes, 'pr')
assert.equal(p.wanted, 'Bug fixes and translations.', 'the owner says what they want')

commitUp('XTEND.md', '# app\n\ncontributions: none\n', 'no thanks')
assert.equal(preview(gh).takes, null)
refuses(/contributions: none/, 'the owner can say no')

git(fork, 'switch', '-q', '-C', 'daily', 'main')
r = xtend(fork, ['daily', 'on'], gh)
assert.equal(r.status, 0, r.stderr + r.stdout)
const yml = path.join(fork, '.github/workflows/xtend.yml')
assert.match(fs.readFileSync(yml, 'utf8'), /xtend\.mjs sync/)
assert.match(git(bare, 'show', 'daily:.github/workflows/xtend.yml'), /cron/, 'the Action is pushed to your fork')
assert.ok(ghCalls('-X').some((c) => c.args.includes('repos/me/app/actions/permissions')), 'Actions get turned on')
assert.match(xtend(fork, ['daily', 'on'], gh).stdout, /already on/)
r = xtend(fork, ['daily', 'off'], gh)
assert.equal(r.status, 0, r.stderr)
assert.ok(!fs.existsSync(yml), 'daily off removes only the Action')
assert.match(git(fork, 'log', '-1', '--format=%s'), /daily sync off/)

fs.rmSync(root, { recursive: true, force: true })
console.log('e2e ok')
