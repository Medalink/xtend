#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = '.xtend'
const CONFIG = `${DIR}/config.json`
const FORK_SHEET = `${DIR}/sheet.md`
const OWNER_SHEET = 'XTEND.md'
const TRIES = 3

const AGENTS = {
  claude: 'claude -p --allowedTools "Edit,Write,Bash(git rm *),Bash(git mv *)"',
  codex: 'codex exec -s workspace-write -',
}

const HELP = `xtend: keep your own version of any repo, with upstream merged in for you.

  xtend get <owner/repo | url | path>   fork, clone, write the ref sheet, turn on auto-sync
  xtend "<what you want>"               your agent makes the change and commits it
  xtend sync                            merge upstream; your agent resolves conflicts
  xtend sheet                           (re)write the ref sheet agents read before editing
  xtend share [--json]                  what upstream accepts, and which of your changes you could offer
  xtend share <n>... [--yes]            offer those changes upstream, the way the owner asks for them

Owners: run \`xtend sheet\` in your repo and commit XTEND.md. Nothing else is needed.
Its \`contributions:\` line (pr, issue or none) decides what forks may send back.`

class Fail extends Error {}

// Hooks would run code an agent planted inside xtend's own git commands, so every git that xtend starts runs without them. Your check is the gate.
const configs = Number(process.env.GIT_CONFIG_COUNT || 0)
Object.assign(process.env, {
  GIT_CONFIG_COUNT: String(configs + 1),
  [`GIT_CONFIG_KEY_${configs}`]: 'core.hooksPath',
  [`GIT_CONFIG_VALUE_${configs}`]: process.platform === 'win32' ? 'NUL' : '/dev/null',
})

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts })
  if (r.error) throw new Fail(`${cmd}: ${r.error.message}`)
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function git(...args) {
  const r = run('git', args)
  if (!r.ok) throw new Fail(`git ${args.join(' ')}\n${r.err || r.out}`)
  return r.out
}

const tryGit = (...args) => run('git', args).ok
const gh = (args, opts) => (process.env.XTEND_GH ? run(process.execPath, [process.env.XTEND_GH, ...args], opts) : run('gh', args, opts))
const hasGh = () => !!process.env.XTEND_GH || has('gh')
const has = (bin) => run(process.platform === 'win32' ? 'where' : 'which', [bin]).ok
const log = (msg) => console.log(`xtend: ${msg}`)

function shell(cmd, input) {
  const r = spawnSync(cmd, { shell: true, input, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'inherit'] })
  return { ok: r.status === 0, out: (r.stdout || '').trim() }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) throw new Fail(`no ${CONFIG} here. Run \`xtend get <repo>\` first.`)
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  return { ...cfg, agent: process.env.XTEND_AGENT || cfg.agent }
}

const defaultAgent = () => process.env.XTEND_AGENT || (has('claude') ? AGENTS.claude : has('codex') ? AGENTS.codex : AGENTS.claude)

function sheet() {
  for (const f of [OWNER_SHEET, FORK_SHEET]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8')
  return '(no ref sheet yet)'
}

function requireClean() {
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Fail('working tree has uncommitted changes. Commit or stash them first.')
}

function pushIfFork() {
  if (!tryGit('remote', 'get-url', 'origin')) return
  const r = run('git', ['push', 'origin', 'HEAD'])
  if (r.ok) return log('pushed to origin')
  log(`push failed, run \`git push\` yourself:\n${r.err}`)
  process.exitCode = 1
}

// Git config, attributes and hooks steer every later git command, xtend's and yours, so an agent must not change them.
function gitSnapshot() {
  const hooks = path.join(git('rev-parse', '--git-common-dir'), 'hooks')
  const fixed = ['config', 'config.worktree', 'info/attributes'].map((f) => git('rev-parse', '--git-path', f))
  const hookEntries = () => (fs.existsSync(hooks) ? fs.readdirSync(hooks).map((f) => path.join(hooks, f)) : [])
  const read = (p) => {
    const s = fs.lstatSync(p, { throwIfNoEntry: false })
    return !s ? null : s.isFile() ? fs.readFileSync(p) : `${s.isSymbolicLink() ? 'link' : 'dir'}:${s.isSymbolicLink() ? fs.readlinkSync(p) : ''}`
  }
  const same = (a, b) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b)
  const saved = new Map([...fixed, ...hookEntries()].map((p) => [p, read(p)]))
  return () => {
    let changed = false
    try {
      for (const p of hookEntries()) if (!saved.has(p)) { fs.rmSync(p, { recursive: true, force: true }); changed = true }
      for (const [p, was] of saved) {
        const now = read(p)
        if (same(now, was)) continue
        changed = true
        if (!Buffer.isBuffer(was) && was !== null) continue
        fs.rmSync(p, { recursive: true, force: true })
        if (was) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, was) }
      }
    } catch { changed = true }
    return changed
  }
}

// Runs the agent until `verify` returns null, feeding each failure back in.
function agentUntil(cfg, prompt, verify) {
  let problem = null
  for (let i = 1; i <= TRIES; i++) {
    log(`asking agent (${cfg.agent.split(' ')[0]}), try ${i}/${TRIES}`)
    const restoreGit = gitSnapshot()
    const r = shell(cfg.agent, problem ? `${prompt}\n\n## Your last attempt failed this check\n${problem}` : prompt)
    if (restoreGit()) return { problem: 'the agent changed git config, attributes or hooks; xtend restored them and stopped' }
    if (!r.ok) return { problem: 'agent exited with an error', summary: r.out }
    problem = verify()
    if (!problem) return { problem: null, summary: r.out }
  }
  return { problem }
}

function check(cfg) {
  if (!cfg.check) return null
  const r = spawnSync(cfg.check, { shell: true, encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 ? null : `\`${cfg.check}\` failed:\n${`${r.stdout}\n${r.stderr}`.trim().slice(-4000)}`
}

// Call after `git add -A`. A lone ======= line only counts in files that had conflicts.
function markersLeft(conflicted) {
  const left = [
    run('git', ['grep', '--cached', '-lE', '^(<<<<<<<|>>>>>>>) ']).out,
    conflicted && run('git', ['grep', '--cached', '-lE', '^=======[[:space:]]*$', '--', ...conflicted.split('\n')]).out,
  ].filter(Boolean).join('\n')
  return left ? `conflict markers left in:\n${left}` : null
}

const RULES = `Rules: edit and create files in the working tree. To delete or move a file, use \`git rm\` or \`git mv\`. Run no other git command. You don't need to run tests: xtend runs the project's check when you finish and sends any failure back to you.`
const SUMMARY = 'Finish with 1 to 3 plain sentences saying what you changed and why. They become the commit message.'

// --- get ---------------------------------------------------------------

function githubSlug(src) {
  const m = src.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m && !fs.existsSync(src) ? `${m[1]}/${m[2]}` : null
}

function get(src) {
  if (!src) throw new Fail('usage: xtend get <owner/repo | url | path>')
  const slug = githubSlug(src)
  const name = path.basename(slug || src).replace(/\.git$/, '')
  if (fs.existsSync(name)) throw new Fail(`${name} already exists`)

  if (slug && hasGh()) {
    log(`forking ${slug} on GitHub`)
    const r = gh(['repo', 'fork', slug, '--clone', '--default-branch-only'], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (!r.ok) throw new Fail('gh repo fork failed')
  } else {
    git('clone', slug ? `https://github.com/${slug}.git` : src, name)
    git('-C', name, 'remote', 'rename', 'origin', 'upstream')
  }
  process.chdir(name)

  tryGit('remote', 'set-head', 'upstream', '--auto')
  const branch = git('rev-parse', '--abbrev-ref', 'upstream/HEAD').replace(/^upstream\//, '')
  const cfg = { upstream: git('remote', 'get-url', 'upstream'), branch, agent: defaultAgent(), check: '' }

  git('config', 'rerere.enabled', 'true')
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
  fs.copyFileSync(fileURLToPath(import.meta.url), `${DIR}/xtend.mjs`)
  const fork = tryGit('remote', 'get-url', 'origin')
  if (fork) {
    fs.mkdirSync('.github/workflows', { recursive: true })
    fs.writeFileSync('.github/workflows/xtend.yml', WORKFLOW)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'xtend: set up')

  if (fs.existsSync(OWNER_SHEET)) log(`upstream ships ${OWNER_SHEET}, using it`)
  else writeSheet(cfg)

  if (fork) {
    pushIfFork()
    const repo = githubSlug(git('remote', 'get-url', 'origin'))
    gh(['api', '-X', 'PUT', `repos/${repo}/actions/permissions`, '-F', 'enabled=true'])
    log(`daily auto-sync is on. Give it a key once: gh secret set ANTHROPIC_API_KEY -R ${repo}`)
  }
  log(`upstream ${stance(readPolicy(cfg))}`)
  log(`ready in ./${name}. Try: cd ${name} && xtend "describe a change"`)
}

// --- sheet -------------------------------------------------------------

function hotFiles() {
  const r = run('git', ['log', '-n', '300', '--format=', '--name-only'])
  const counts = {}
  for (const f of r.out.split('\n').filter(Boolean)) counts[f] = (counts[f] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `${n}\t${f}`).join('\n')
}

function writeSheet(cfg) {
  const target = fs.existsSync(CONFIG) ? FORK_SHEET : OWNER_SHEET
  const prompt = `Write a reference sheet for coding agents that will customize a private copy of this repository, at ${target}.
Read the code first. Keep it under 150 lines of Markdown. Be concrete: real paths, real commands, no filler.

Sections:
# <project name>
## What it is (2-3 sentences)
## Map (key directories and files, one line each)
## Build, run, test (exact commands)
## Extension points (where to add common kinds of changes, which file and which pattern to copy)
## Conventions (naming, style, patterns new code must follow)
## Hot zones (files upstream changes often; local edits there should stay small and isolated)

Most-changed files in recent history (commits, path):
${hotFiles() || '(no history)'}

${RULES} Write only ${target}.`
  const r = agentUntil(cfg, prompt, () => (fs.existsSync(target) ? null : `${target} was not written`))
  if (r.problem) throw new Fail(`could not write ${target}: ${r.problem}`)
  if (target === OWNER_SHEET && !/^contributions:/m.test(fs.readFileSync(target, 'utf8'))) fs.appendFileSync(target, CONTRIBUTIONS)
  if (fs.existsSync(CONFIG)) {
    git('add', target)
    git('commit', '-q', '-m', 'xtend: write ref sheet')
  }
  log(`wrote ${target}`)
}

// --- change ------------------------------------------------------------

function change(cfg, request) {
  requireClean()
  const before = git('rev-parse', 'HEAD')
  const prompt = `# Ref sheet\n${sheet()}\n\n# Request\n${request}\n
Make this change to the repository. Prefer new files and small, isolated edits to existing ones, so future upstream merges stay easy.
${RULES}
${SUMMARY}`
  const r = agentUntil(cfg, prompt, () => {
    if (git('rev-parse', 'HEAD') !== before) git('reset', '-q', '--soft', before)
    git('add', '-A')
    return git('diff', '--cached', '--name-only') ? check(cfg) : 'no files changed'
  })
  if (r.problem) {
    if (git('rev-parse', 'HEAD') !== before) git('reset', '-q', '--soft', before)
    log(`change not committed: ${r.problem}\nThe agent's edits are left in your working tree.`)
    process.exitCode = 1
    return
  }
  git('commit', '-q', '-m', `xtend: ${request}`, '-m', r.summary || request)
  log('committed')
  pushIfFork()
}

// --- sync --------------------------------------------------------------

function sync(cfg) {
  requireClean()
  if (!tryGit('remote', 'get-url', 'upstream')) git('remote', 'add', 'upstream', cfg.upstream)
  git('fetch', '-q', 'upstream', cfg.branch)
  const theirs = `upstream/${cfg.branch}`
  if (tryGit('merge-base', '--is-ancestor', theirs, 'HEAD')) {
    log('already up to date')
    return pushIfFork()
  }

  const before = git('rev-parse', 'HEAD')
  const incoming = git('log', '--no-merges', '--format=- %s', `HEAD..${theirs}`)
  const ours = git('log', '--no-merges', '--format=- %B', `${theirs}..HEAD`)
  run('git', ['merge', '--no-ff', '--no-commit', theirs])
  const conflicted = git('diff', '--name-only', '--diff-filter=U')

  const verify = () => {
    if (!fs.existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) return 'the merge was committed or aborted; leave that to xtend'
    git('add', '-A')
    return markersLeft(conflicted) || check(cfg)
  }

  let problem
  try {
    problem = conflicted ? `conflicts in:\n${conflicted}` : verify()
    if (problem) problem = resolveMerge(cfg, { ours, incoming, problem }, verify)
    if (!problem) {
      const c = run('git', ['commit', '-q', '-m', `xtend: sync ${theirs} (${git('rev-parse', '--short', theirs)})`])
      if (!c.ok) problem = `git commit failed:\n${c.err || c.out}`
    }
  } catch (e) {
    problem = e.message
  }
  if (problem) {
    git('reset', '-q', '--hard', before)
    git('clean', '-qfd')
    throw new Fail(`sync gave up, nothing changed:\n${problem}`)
  }
  log(conflicted ? `merged upstream, agent resolved: ${conflicted.split('\n').join(', ')}` : 'merged upstream cleanly')
  pushIfFork()
}

function resolveMerge(cfg, { ours, incoming, problem }, verify) {
  const prompt = `# Ref sheet\n${sheet()}\n
# Task
You are merging new upstream changes into a customized copy of this project. A git merge is in progress.
Keep every upstream change AND keep every local customization working. When they collide, re-apply the local intent on top of the new upstream code.

## Local customizations (their intent, newest first)
${ours || '(none recorded)'}

## Incoming upstream changes
${incoming}

## What is wrong right now
${problem}

${RULES} Remove all conflict markers.`
  return agentUntil(cfg, prompt, verify).problem
}

// --- share -------------------------------------------------------------

const OFFER_BRANCH = 'xtend/offer'
const OFFER_MARK = '<!-- xtend offer -->'
const MINE = ['.', ':!.xtend', ':!.github/workflows/xtend.yml']
const DAILY_OFFERS = 3
const CONTRIBUTIONS = `
## Contributions from forks
contributions: pr
<!-- pr, issue or none. xtend reads this line before a fork offers changes back. List what you would welcome below it. -->
`
const CONTRIBUTING_DOCS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'CONTRIBUTING']
const PR_TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md']
const REFUSE = /\b(?:not|never|no longer)\s+(?:accept|take|review|merge)\w*\s+(?:any\s+|unsolicited\s+|external\s+|outside\s+)?/

// Lines in a project's contributing docs that close a channel or add a requirement. Nothing reopens a channel.
const SIGNALS = [
  { re: new RegExp(REFUSE.source + /(?:contributions|patches|changes)\b/.source, 'i'), close: ['pr', 'issue'], say: 'it does not take contributions' },
  { re: new RegExp(REFUSE.source + /(?:pull requests|PRs)\b/.source, 'i'), close: ['pr'], say: 'it does not take pull requests' },
  { re: /^(?=.*\b(?:AI|LLMs?|GPT|Copilot|generative|machine[- ]generated)\b)(?=.*\b(?:not|no|never|ban\w*|prohibit\w*|reject\w*|forbid\w*)\b)/i, close: ['pr', 'issue'], say: 'it restricts AI-generated contributions' },
  { re: /\b(?:open|file|create|start)\s+(?:an?\s+)?(?:issue|discussion)\s+(?:first|before)\b|\bdiscuss\w*\b.{0,40}\bbefore\b.{0,40}\b(?:pull request|PR)\b/i, close: ['pr'], say: 'it wants an issue before a pull request' },
  { re: /Signed-off-by|\bDCO\b|Developer Certificate of Origin/, signoff: true, say: 'every commit needs a DCO sign-off' },
  { re: /\bCLA\b|Contributor License Agreement/, say: 'it needs a signed CLA, which only you can sign' },
]

// What upstream accepts, read from its latest code and from GitHub. Every source can only narrow it.
function readPolicy(cfg) {
  const show = (f) => { const r = run('git', ['show', `upstream/${cfg.branch}:${f}`]); return r.ok ? r.out : null }
  const p = { open: new Set(['pr', 'issue']), notes: [], signoff: false, wanted: '', template: '' }
  const close = (channels, say, where) => {
    for (const c of channels) p.open.delete(c)
    p.notes.push(where ? `${say}: ${where}` : say)
  }

  const owner = show(OWNER_SHEET) || ''
  const stated = owner.match(/^contributions:\s*(\w+)[^\n]*\n?((?:(?!## )[^\n]*\n?)*)/m)
  if (stated) {
    const allow = { pr: ['pr', 'issue'], issue: ['issue'], none: [] }[stated[1].toLowerCase()] ?? ['pr', 'issue']
    const shut = ['pr', 'issue'].filter((c) => !allow.includes(c))
    if (shut.length) close(shut, 'the owner said so', `${OWNER_SHEET} has "contributions: ${stated[1]}"`)
    p.wanted = stated[2].replace(/<!--[\s\S]*?-->/g, '').trim()
  }

  const slug = githubSlug(cfg.upstream)
  const online = slug && hasGh()
  if (online) {
    const r = gh(['api', `repos/${slug}`])
    const repo = r.ok ? JSON.parse(r.out) : {}
    if (repo.archived) close(['pr', 'issue'], 'it is archived')
    if (repo.has_pull_requests === false || (repo.pull_request_creation_policy && repo.pull_request_creation_policy !== 'all')) close(['pr'], 'GitHub only lets collaborators open pull requests there')
    if (repo.has_issues === false) close(['issue'], 'its issues are turned off')
  }

  const docs = CONTRIBUTING_DOCS.map((f) => [f, show(f)]).filter(([, text]) => text)
  if (!docs.length && online) {
    const url = gh(['api', `repos/${slug}/community/profile`, '--jq', '.files.contributing.url // ""']).out.replace('https://api.github.com/', '')
    const c = url && gh(['api', url, '--jq', '.content'])
    if (c && c.ok) docs.push(['CONTRIBUTING.md (organization default)', Buffer.from(c.out, 'base64').toString('utf8')])
  }
  for (const [f, text] of docs) {
    const lines = text.split(/\r?\n/)
    for (const s of SIGNALS) {
      const i = lines.findIndex((l) => s.re.test(l))
      if (i < 0) continue
      if (s.signoff) p.signoff = true
      close(s.close || [], s.say, `${f}:${i + 1} "${lines[i].trim().slice(0, 120)}"`)
    }
  }
  if (/^blank_issues_enabled:\s*false/m.test(show('.github/ISSUE_TEMPLATE/config.yml') || '')) close(['issue'], 'it only takes issues through its forms', '.github/ISSUE_TEMPLATE/config.yml')
  p.template = PR_TEMPLATES.map(show).find(Boolean) || ''
  return p
}

const channel = (p) => (p.open.has('pr') ? 'pr' : p.open.has('issue') ? 'issue' : null)
const TAKES = { pr: 'takes pull requests', issue: 'takes issues, not pull requests', null: 'takes no changes from forks' }
const stance = (p) => [TAKES[channel(p)], ...p.notes.map((n) => `  - ${n}`)].join('\n')

// Your own commits since upstream, minus xtend's setup files.
function offerable(theirs) {
  return git('rev-list', '--reverse', '--no-merges', `${theirs}..HEAD`).split('\n').filter(Boolean).map((sha) => ({
    sha,
    subject: git('log', '-1', '--format=%s', sha).replace(/^xtend: /, ''),
    body: git('log', '-1', '--format=%b', sha),
    files: git('diff-tree', '--no-commit-id', '--name-only', '-r', sha, '--', ...MINE).split('\n').filter(Boolean),
    clean: run('git', ['merge-tree', '--write-tree', `--merge-base=${sha}^`, theirs, sha]).ok,
  })).filter((c) => c.files.length)
}

// Earlier offers from you to this upstream: the one still open, and the changes in ones the owner closed.
function pastOffers(slug, strict) {
  const found = { open: null, closed: new Set() }
  for (const kind of ['pr', 'issue']) {
    const r = gh([kind, 'list', '-R', slug, '--author', '@me', '--state', 'all', '--limit', '100', '--json', 'url,body,state'])
    if (!r.ok && strict) throw new Fail(`could not list your ${kind}s on ${slug}, so xtend cannot tell whether you already have an offer open:\n${r.err}`)
    if (!r.ok) continue
    for (const o of JSON.parse(r.out || '[]')) {
      if (!o.body?.includes(OFFER_MARK)) continue
      if (o.state === 'OPEN') found.open ||= { kind, url: o.url }
      else if (o.state === 'CLOSED') for (const m of o.body.matchAll(/ported from fork commit `([0-9a-f]{7,40})`/gi)) found.closed.add(m[1])
    }
  }
  return found
}
const wasClosed = (past, c) => [...past.closed].some((s) => c.sha.startsWith(s))

const offersFile = () => path.join(process.env.XTEND_HOME || path.join(os.homedir(), '.xtend'), 'offers.json')
function recentOffers() {
  try { return JSON.parse(fs.readFileSync(offersFile(), 'utf8')).filter((o) => Date.now() - o.at < 864e5) } catch { return [] }
}

function confirm(question) {
  if (!process.stdin.isTTY) throw new Fail(`${question}\nRerun with --yes to go ahead.`)
  process.stdout.write(`${question} [y/N] `)
  const buf = Buffer.alloc(16)
  let n = 0
  try { n = fs.readSync(0, buf, 0, buf.length) } catch {}
  if (!/^y/i.test(buf.toString('utf8', 0, n))) throw new Fail('nothing sent')
}

// Re-applies each picked change on upstream's latest code, one commit each, on OFFER_BRANCH.
function port(cfg, picked, theirs, signoff) {
  const home = git('symbolic-ref', '--short', 'HEAD')
  const ref = sheet()
  let done = false
  git('switch', '-q', '-C', OFFER_BRANCH, theirs)
  try {
    for (const c of picked) {
      const base = git('rev-parse', 'HEAD')
      const patch = spawnSync('git', ['diff', '--binary', '--full-index', `${c.sha}^`, c.sha, '--', ...MINE], { maxBuffer: 64 << 20 }).stdout
      const applied = run('git', ['apply', '--3way', '--whitespace=nowarn'], { input: patch })
      const conflicted = git('diff', '--name-only', '--diff-filter=U')
      const verify = () => {
        if (git('rev-parse', 'HEAD') !== base) git('reset', '-q', '--soft', base)
        git('add', '-A')
        return markersLeft(conflicted) || check(cfg)
      }
      let problem = applied.ok ? verify() : conflicted ? `conflicts in:\n${conflicted}` : `the diff did not apply:\n${applied.err}`
      if (problem) {
        const prompt = `# Ref sheet\n${ref}\n
# Task
You are preparing one change from a customized fork so the upstream owner can take it. The working tree is upstream's latest code.
Re-apply this change on top of it. Leave upstream's code as it is wherever this change does not need to touch it, and bring in no other customization.

## The change
${c.subject}
${c.body}

## Its original diff
${patch.toString('utf8').slice(0, 20000)}

## What is wrong right now
${problem}

${RULES} Remove all conflict markers.
${SUMMARY}`
        const r = agentUntil(cfg, prompt, verify)
        problem = r.problem
        if (r.summary) c.body = r.summary
      }
      if (problem) throw new Fail(`could not port "${c.subject}" onto upstream:\n${problem}`)
      if (!git('diff', '--cached', '--name-only')) { log(`upstream already has "${c.subject}"`); continue }
      git('commit', '-q', ...(signoff ? ['-s'] : []), '-m', c.subject, '-m', c.body || c.subject)
      c.port = git('rev-parse', 'HEAD')
      c.files = git('diff-tree', '--no-commit-id', '--name-only', '-r', c.port).split('\n').filter(Boolean)
      c.alone = run('git', ['merge-tree', '--write-tree', `--merge-base=${c.port}^`, theirs, c.port]).ok
    }
    done = true
  } finally {
    run('git', ['reset', '-q', '--hard'])
    run('git', ['clean', '-qfd'])
    run('git', ['switch', '-q', home])
    if (!done) run('git', ['branch', '-D', OFFER_BRANCH])
  }
}

function offerBody(cfg, policy, via, ported, forkSlug) {
  const fetch = forkSlug ? `git fetch https://github.com/${forkSlug}.git ${OFFER_BRANCH}` : `git fetch <fork> ${OFFER_BRANCH}`
  const items = ported.map((c, i) => [
    `### ${i + 1}. ${c.subject}`,
    c.body,
    `Files: ${c.files.map((f) => `\`${f}\``).join(', ')}. Ported from fork commit \`${c.sha.slice(0, 12)}\`.${c.alone ? '' : ' Take the change above it first.'}`,
    `\`\`\`sh\n${fetch}\ngit cherry-pick ${c.port}\n\`\`\``,
  ].filter(Boolean).join('\n\n'))
  return [
    OFFER_MARK,
    via === 'pr' && policy.template.trim(),
    `Changes from a fork of this project, offered back in case you want any of them. Each one is a single commit on \`${cfg.branch}\`. ${via === 'pr' ? 'Merge them all, or take' : 'Take'} any one with the commands under it.`,
    ...items,
    `A person picked these. xTend ported them onto your latest code with \`${cfg.agent.split(' ')[0]}\`${cfg.check ? ` and ran \`${cfg.check}\`` : ''}. If you close this, xTend will not offer these changes again.`,
  ].filter(Boolean).join('\n\n')
}

function share(cfg, args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const picks = [...new Set(args.filter((a) => /^\d+$/.test(a)).map(Number))].sort((a, b) => a - b)
  const unknown = args.filter((a) => !/^\d+$/.test(a) && !['--yes', '--signoff', '--json'].includes(a))
  if (unknown.length) throw new Fail(`share takes change numbers, --yes, --signoff and --json, not: ${unknown.join(' ')}`)

  if (!tryGit('remote', 'get-url', 'upstream')) git('remote', 'add', 'upstream', cfg.upstream)
  git('fetch', '-q', 'upstream', cfg.branch)
  const theirs = `upstream/${cfg.branch}`
  const policy = readPolicy(cfg)
  const via = channel(policy)
  const changes = offerable(theirs)
  const slug = githubSlug(cfg.upstream)
  const forkSlug = tryGit('remote', 'get-url', 'origin') ? githubSlug(git('remote', 'get-url', 'origin')) : null
  const online = !!(slug && forkSlug && hasGh())
  const past = online ? pastOffers(slug, picks.length > 0) : { open: null, closed: new Set() }

  if (!picks.length) {
    const list = changes.map((c, i) => ({ n: i + 1, subject: c.subject, files: c.files, appliesCleanly: c.clean, closedBefore: wasClosed(past, c) }))
    if (flags.has('--json')) return console.log(JSON.stringify({ takes: via, notes: policy.notes, signoff: policy.signoff, wanted: policy.wanted, open: past.open?.url || null, changes: list }, null, 2))
    log(`upstream ${stance(policy)}`)
    if (policy.wanted) console.log(`\nThe owner would welcome:\n${policy.wanted}`)
    if (past.open) console.log(`\nYour open offer: ${past.open.url}. Sharing again updates it.`)
    console.log(list.length
      ? `\nYour changes:\n${list.map((c) => `  ${c.n}. ${c.subject} (${c.files.length} file${c.files.length === 1 ? '' : 's'}, ${c.closedBefore ? 'the owner closed it before' : c.appliesCleanly ? 'applies cleanly' : 'your agent will port it'})`).join('\n')}`
      : '\nNothing to offer yet: every commit so far is xtend setup.')
    if (via && list.length) console.log(`\nOffer some with: xtend share ${list.length > 1 ? '1 2' : '1'}`)
    return
  }

  if (process.env.CI || process.env.GITHUB_ACTIONS) throw new Fail('xtend never offers changes from CI. A person runs `xtend share` on purpose.')
  if (!via) throw new Fail(`upstream ${stance(policy)}\nxtend will not offer changes there.`)
  const bad = picks.filter((n) => n < 1 || n > changes.length)
  if (bad.length) throw new Fail(`there is no change ${bad.join(', ')}. Run \`xtend share\` to see the list.`)
  const picked = picks.map((n) => changes[n - 1])
  const declined = picked.filter((c) => wasClosed(past, c))
  if (declined.length) throw new Fail(`the owner closed an earlier offer of: ${declined.map((c) => c.subject).join(', ')}. xtend will not offer it again.`)
  if (policy.signoff && !flags.has('--signoff')) throw new Fail('upstream needs a DCO sign-off on every commit. Read it, then rerun with --signoff if you agree to it.')
  if (online && !past.open && recentOffers().length >= DAILY_OFFERS) throw new Fail(`you opened ${DAILY_OFFERS} offers in the last day. xtend caps this so no one floods maintainers.`)
  requireClean()
  const where = past.open ? `update ${past.open.url}` : `open ${via === 'pr' ? 'a draft pull request' : 'an issue'} on ${slug || cfg.upstream}`
  if (!flags.has('--yes')) confirm(`Offer ${picked.map((c) => `"${c.subject}"`).join(', ')} and ${where}?`)

  port(cfg, picked, theirs, flags.has('--signoff'))
  const ported = picked.filter((c) => c.port)
  if (!ported.length) { run('git', ['branch', '-D', OFFER_BRANCH]); return log('upstream already has every change you picked. Nothing sent.') }
  const body = offerBody(cfg, policy, via, ported, forkSlug)

  const pushed = tryGit('remote', 'get-url', 'origin') && run('git', ['push', '-q', '-f', 'origin', OFFER_BRANCH]).ok
  if (!online) {
    const file = git('rev-parse', '--git-path', 'xtend-offer.md')
    fs.writeFileSync(file, body)
    return log(`branch ${OFFER_BRANCH} is ready${pushed ? ' and pushed to origin' : ''}, with a write-up in ${file}. Upstream is not on GitHub, so send it the way its owner asks.`)
  }
  if (!pushed) throw new Fail(`could not push ${OFFER_BRANCH} to origin. Nothing was opened upstream.`)
  const title = ported.length === 1 ? ported[0].subject : `${ported.length} changes from ${forkSlug}`
  const r = past.open
    ? gh([past.open.kind, 'edit', past.open.url, '--title', title, '--body-file', '-'], { input: body })
    : via === 'pr'
      ? gh(['pr', 'create', '-R', slug, '--draft', '--base', cfg.branch, '--head', `${forkSlug.split('/')[0]}:${OFFER_BRANCH}`, '--title', title, '--body-file', '-'], { input: body })
      : gh(['issue', 'create', '-R', slug, '--title', title, '--body-file', '-'], { input: body })
  if (!r.ok) throw new Fail(`gh could not ${where}:\n${r.err}`)
  if (!past.open) {
    fs.mkdirSync(path.dirname(offersFile()), { recursive: true })
    fs.writeFileSync(offersFile(), JSON.stringify([...recentOffers(), { repo: slug, url: r.out, at: Date.now() }], null, 2))
  }
  log(past.open ? `updated ${past.open.url}` : `opened ${r.out}`)
}

const WORKFLOW = `name: xtend sync
on:
  schedule: [{ cron: '17 6 * * *' }]
  workflow_dispatch:
permissions:
  contents: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npm i -g @anthropic-ai/claude-code
      - run: |
          git config user.name "xtend"
          git config user.email "xtend@users.noreply.github.com"
          node .xtend/xtend.mjs sync
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          XTEND_AGENT: '${AGENTS.claude}'
`

// --- main --------------------------------------------------------------

const [verb, ...rest] = process.argv.slice(2)
try {
  if (!verb || verb === 'help' || verb === '-h' || verb === '--help') console.log(HELP)
  else if (verb === 'get') get(rest[0])
  else if (verb === 'sync') sync(loadConfig())
  else if (verb === 'share') share(loadConfig(), rest)
  else if (verb === 'sheet') writeSheet(fs.existsSync(CONFIG) ? loadConfig() : { agent: defaultAgent() })
  else change(loadConfig(), [verb, ...rest].join(' '))
} catch (e) {
  if (!(e instanceof Fail)) throw e
  console.error(`xtend: ${e.message}`)
  process.exitCode = 1
}
