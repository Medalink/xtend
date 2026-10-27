#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = '.xtend'
const CONFIG = `${DIR}/config.json`
const FORK_SHEET = `${DIR}/sheet.md`
const OWNER_SHEET = 'XTEND.md'
const TRIES = 3

const AGENTS = {
  claude: 'claude -p --permission-mode acceptEdits --allowedTools "Bash(git rm *),Bash(git mv *)"',
  codex: 'codex exec -s workspace-write -',
}

const HELP = `xtend: keep your own version of any repo, with upstream merged in for you.

  xtend get <owner/repo | url | path>   fork, clone, write the ref sheet, turn on auto-sync
  xtend "<what you want>"               your agent makes the change and commits it
  xtend sync                            merge upstream; your agent resolves conflicts
  xtend sheet                           (re)write the ref sheet agents read before editing

Owners: run \`xtend sheet\` in your repo and commit XTEND.md. Nothing else is needed.`

class Fail extends Error {}

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

// git runs hooks and reads config on our next command, so an agent must not be able to change them.
function gitSnapshot() {
  const dir = git('rev-parse', '--git-common-dir')
  const list = () => ['config', ...fs.readdirSync(path.join(dir, 'hooks'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `hooks/${e.name}`)]
  const files = new Map(list().map((f) => [f, fs.readFileSync(path.join(dir, f))]))
  return () => {
    let changed = false
    for (const f of list()) if (!files.has(f)) { fs.rmSync(path.join(dir, f)); changed = true }
    for (const [f, buf] of files) {
      const p = path.join(dir, f)
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(buf)) { fs.writeFileSync(p, buf); changed = true }
    }
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
    if (restoreGit()) return { problem: 'the agent changed .git/config or .git/hooks; xtend restored them and stopped' }
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

const RULES = `Rules: edit and create files in the working tree. To delete or move a file, use \`git rm\` or \`git mv\`. Run no other git command.`

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

  if (slug && has('gh')) {
    log(`forking ${slug} on GitHub`)
    const r = run('gh', ['repo', 'fork', slug, '--clone', '--default-branch-only'], { stdio: ['ignore', 'inherit', 'inherit'] })
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
    run('gh', ['api', '-X', 'PUT', `repos/${repo}/actions/permissions`, '-F', 'enabled=true'])
    log(`daily auto-sync is on. Give it a key once: gh secret set ANTHROPIC_API_KEY -R ${repo}`)
  }
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
Finish with a short plain-text summary of what you changed and why.`
  const r = agentUntil(cfg, prompt, () => {
    if (git('rev-parse', 'HEAD') !== before) git('reset', '-q', '--soft', before)
    git('add', '-A')
    return git('diff', '--cached', '--name-only') ? check(cfg) : 'no files changed'
  })
  if (r.problem) {
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
  if (tryGit('merge-base', '--is-ancestor', theirs, 'HEAD')) return log('already up to date')

  const before = git('rev-parse', 'HEAD')
  const incoming = git('log', '--no-merges', '--format=- %s', `HEAD..${theirs}`)
  const ours = git('log', '--no-merges', '--format=- %B', `${theirs}..HEAD`)
  run('git', ['merge', '--no-ff', '--no-commit', theirs])
  const conflicted = git('diff', '--name-only', '--diff-filter=U')

  const verify = () => {
    if (!fs.existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) return 'the merge was committed or aborted; leave that to xtend'
    git('add', '-A')
    const markers = [
      run('git', ['grep', '--cached', '-lE', '^(<<<<<<<|>>>>>>>) ']).out,
      conflicted && run('git', ['grep', '--cached', '-lE', '^=======.?$', '--', ...conflicted.split('\n')]).out,
    ].filter(Boolean).join('\n')
    if (markers) return `conflict markers left in:\n${markers}`
    return check(cfg)
  }

  let problem = conflicted ? `conflicts in:\n${conflicted}` : verify()
  if (problem) {
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
    problem = agentUntil(cfg, prompt, verify).problem
  }
  if (!problem) {
    const c = run('git', ['commit', '-q', '-m', `xtend: sync ${theirs} (${git('rev-parse', '--short', theirs)})`])
    if (!c.ok) problem = `git commit failed:\n${c.err || c.out}`
  }
  if (problem) {
    git('reset', '-q', '--hard', before)
    git('clean', '-qfd')
    throw new Fail(`sync gave up, nothing changed:\n${problem}`)
  }
  log(conflicted ? `merged upstream, agent resolved: ${conflicted.split('\n').join(', ')}` : 'merged upstream cleanly')
  pushIfFork()
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
  else if (verb === 'sheet') writeSheet(fs.existsSync(CONFIG) ? loadConfig() : { agent: defaultAgent() })
  else change(loadConfig(), [verb, ...rest].join(' '))
} catch (e) {
  if (!(e instanceof Fail)) throw e
  console.error(`xtend: ${e.message}`)
  process.exitCode = 1
}
