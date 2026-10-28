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

// Any command works as the agent: xtend pipes the prompt to its stdin, or writes it to a file and puts the path where {file} is.
// These presets also tell the GitHub Action what to install and which key to pass. Pick one, add flags such as --model, or write your own.
const AGENTS = {
  claude: { cmd: 'claude -p --allowedTools "Edit,Write,Bash(git rm *),Bash(git mv *)"', install: '@anthropic-ai/claude-code', key: 'ANTHROPIC_API_KEY' },
  codex: { cmd: 'codex exec -s workspace-write -', install: '@openai/codex', key: 'OPENAI_API_KEY' },
  gemini: { cmd: 'gemini --approval-mode auto_edit', install: '@google/gemini-cli', key: 'GEMINI_API_KEY' },
  amp: { cmd: 'amp -x', install: '@sourcegraph/amp', key: 'AMP_API_KEY' },
  opencode: { cmd: 'opencode run --auto -f {file} "Do what the attached file asks."', install: 'opencode-ai' },
}

// "codex -m gpt-6" becomes the codex preset plus "-m gpt-6"; anything else is used as written.
// `agents` are your own presets from config: a command, or { cmd, install, key } like the ones above.
function agentCommand(spec, agents = {}) {
  const [first, ...more] = spec.trim().split(/\s+/)
  const known = agents[first]?.cmd ?? agents[first] ?? AGENTS[first]?.cmd
  return known && !spec.trim().startsWith(known) ? [known, ...more].join(' ') : spec.trim()
}
const presetOf = (cmd, agents = {}) => Object.entries({ ...AGENTS, ...agents }).find(([, p]) => p.cmd && cmd.split(' ')[0] === p.cmd.split(' ')[0]) || [cmd.split(' ')[0], {}]

const HELP = `xtend: keep your own version of any repo, with upstream merged in for you.

  xtend get <owner/repo | url | path>   fork, clone and write the ref sheet
      [--agent <preset or command>]     claude, codex, gemini, amp, opencode, or your own command
      [--daily]                         also turn on the daily sync Action
  xtend "<what you want>"               your agent makes the change and commits it
  xtend sync                            merge upstream; your agent resolves conflicts
  xtend sheet                           (re)write the ref sheet agents read before editing
  xtend share [--json]                  what upstream accepts, and which of your changes you could offer
  xtend share <n>... [--yes]            offer those changes upstream, the way the owner asks for them
  xtend agent [preset or command]       show or change the agent, e.g. \`xtend agent codex -m gpt-6\`
  xtend daily [on | off]                show, add or remove the GitHub Action that runs xtend sync every day
  xtend config [--json]                 each step's agent, prompt and commands, and which file set them
  xtend config prompts [<step>...]      copy the prompts to this device to edit: change, sync, port, sheet

Owners: run \`xtend sheet\` in your repo and commit XTEND.md. Nothing else is needed.
Its \`contributions:\` line (pr, issue or none) decides what forks may send back.`

class Fail extends Error {}

// Hooks would run code an agent planted inside xtend's own git commands, so every git that xtend starts runs without them. Your check is the gate.
// rerere is on for every git xtend starts, in CI too, without touching .git/config.
const configs = Number(process.env.GIT_CONFIG_COUNT || 0)
for (const [i, [key, value]] of [['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'], ['rerere.enabled', 'true']].entries()) {
  Object.assign(process.env, { [`GIT_CONFIG_KEY_${configs + i}`]: key, [`GIT_CONFIG_VALUE_${configs + i}`]: value })
}
process.env.GIT_CONFIG_COUNT = String(configs + 2)

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
  const file = cmd.includes('{file}') && path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xtend-')), 'prompt.md')
  if (file) fs.writeFileSync(file, input)
  try {
    const r = spawnSync(file ? cmd.replaceAll('{file}', JSON.stringify(file)) : cmd, { shell: true, input: file ? '' : input, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'inherit'] })
    return { ok: r.status === 0, out: (r.stdout || '').trim() }
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
}

const detectAgent = () => (Object.values(AGENTS).find((p) => has(p.cmd.split(' ')[0])) || AGENTS.claude).cmd
const defaultAgent = () => (process.env.XTEND_AGENT ? agentCommand(process.env.XTEND_AGENT) : detectAgent())
const deviceFile = () => path.join(process.env.XTEND_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'xtend'), 'config.json')
const STEP_KEYS = ['agent', 'prompt', 'add', 'after', 'tries']

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Fail(`${file}: ${e.message}`) }
}

// Settings come from xtend, then the repo's .xtend/config.json (the only file the daily Action sees), then this device's config.json, then XTEND_AGENT.
// A later one wins. A key at the top of a file applies to every step; under steps.<step> it applies to that step only, and wins inside that file.
function loadConfig(need = true) {
  if (need && !fs.existsSync(CONFIG)) throw new Fail(`no ${CONFIG} here. Run \`xtend get <repo>\` first.`)
  const repo = fs.existsSync(CONFIG) ? readJson(CONFIG) : {}
  const layers = [[CONFIG, CONFIG], ['this device', deviceFile()]].filter(([, f]) => fs.existsSync(f)).map(([from, file]) => ({ from, file: path.resolve(file), data: readJson(file) }))
  for (const { file, data } of layers) {
    if (data.prompt) throw new Fail(`${file}: set prompt under steps.<step>, since each step has its own placeholders`)
    for (const [name, s] of Object.entries(data.steps || {})) {
      if (!PROMPTS[name]) throw new Fail(`${file}: there is no step "${name}". Steps: ${Object.keys(PROMPTS).join(', ')}`)
      const bad = Object.keys(s).filter((k) => !STEP_KEYS.includes(k))
      if (bad.length) throw new Fail(`${file}: steps.${name} can set ${STEP_KEYS.join(', ')}, not ${bad.join(', ')}`)
    }
  }
  const agents = Object.assign({}, ...layers.map((l) => l.data.agents))
  const pick = (key, name) => {
    for (const l of [...layers].reverse()) {
      const v = (name && l.data.steps?.[name]?.[key]) ?? (key === 'prompt' ? undefined : l.data[key])
      if (v !== undefined && v !== '') return { value: v, from: l.from, file: l.file }
    }
  }
  let detected
  const steps = {}
  for (const name of Object.keys(PROMPTS)) {
    const agent = process.env.XTEND_AGENT ? { value: process.env.XTEND_AGENT, from: 'XTEND_AGENT' } : pick('agent', name) || { value: (detected ||= detectAgent()), from: 'xtend' }
    const prompt = pick('prompt', name)
    const tries = pick('tries', name) || { value: TRIES, from: 'xtend' }
    if (!Number.isInteger(tries.value) || tries.value < 1) throw new Fail(`${tries.file}: tries must be a whole number above 0`)
    if (prompt) prompt.value = path.resolve(path.dirname(prompt.file), prompt.value)
    if (prompt && !fs.existsSync(prompt.value)) throw new Fail(`${prompt.file}: the ${name} prompt ${prompt.value} does not exist`)
    steps[name] = {
      agent: { ...agent, value: agentCommand(String(agent.value), agents) },
      prompt: prompt || { value: 'built-in', from: 'xtend' },
      template: prompt ? fs.readFileSync(prompt.value, 'utf8') : PROMPTS[name],
      add: pick('add', name),
      after: pick('after', name),
      tries,
    }
  }
  return { ...repo, check: pick('check')?.value || '', checkFrom: pick('check')?.from, steps, layers, repo }
}

// The agent the daily Action runs: the repo's own sync agent, never this device's.
function actionAgent(repo, agent = repo.agent) {
  return agentCommand(String(repo.steps?.sync?.agent || agent), repo.agents)
}

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

// Saves these files and the entries of these directories. The function it returns puts back whatever changed and says whether anything did.
function snapshot(fixed, dirs = []) {
  const hookEntries = () => dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((f) => path.join(d, f)) : []))
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

// Git config, attributes and hooks steer every later git command, xtend's and yours, so an agent must not change them.
const gitSnapshot = () => snapshot(['config', 'config.worktree', 'info/attributes'].map((f) => git('rev-parse', '--git-path', f)), [path.join(git('rev-parse', '--git-common-dir'), 'hooks')])
// Nor xtend's settings, its prompts, or the daily Action and the copy of xtend it runs.
const settingsSnapshot = (cfg) => snapshot([...new Set([CONFIG, `${DIR}/xtend.mjs`, WORKFLOW_FILE, deviceFile(), ...Object.values(cfg.steps).map((s) => s.prompt.file && s.prompt.value).filter(Boolean)].map((f) => path.resolve(f)))])

// Fills each {{name}} in one pass, so text inside the values is never read as a placeholder.
function render(template, vars, where) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (Object.hasOwn(vars, k)) return vars[k]
    throw new Fail(`${where} uses ${m}. This step has ${Object.keys(vars).map((v) => `{{${v}}}`).join(' ')}`)
  })
}

// Runs the step's agent until `verify` returns null, feeding each failure back in. The step's `after` command runs after every attempt, before `verify`.
function agentUntil(cfg, step, vars, verify) {
  const { agent, prompt: source, template, add, after, tries } = cfg.steps[step]
  const prompt = render(template, vars, source.file ? source.value : `the built-in ${step} prompt`) + (add ? `\n\n${add.value}` : '')
  let problem = null
  for (let i = 1; i <= tries.value; i++) {
    log(`asking agent (${agent.value.split(' ')[0]}), try ${i}/${tries.value}`)
    const restoreGit = gitSnapshot()
    const restoreSettings = settingsSnapshot(cfg)
    const r = shell(agent.value, problem ? `${prompt}\n\n## Your last attempt failed this check\n${problem}` : prompt)
    if (restoreGit()) return { problem: 'the agent changed git config, attributes or hooks; xtend restored them and stopped' }
    if (restoreSettings()) return { problem: "the agent changed xtend's settings or prompts; xtend restored them and stopped" }
    if (!r.ok) return { problem: 'agent exited with an error', summary: r.out }
    problem = (after && command(after.value)) || verify()
    if (!problem) return { problem: null, summary: r.out }
  }
  return { problem }
}

function command(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 ? null : `\`${cmd}\` failed:\n${`${r.stdout}\n${r.stderr}`.trim().slice(-4000)}`
}
const check = (cfg) => (cfg.check ? command(cfg.check) : null)

// rerere replays resolutions it recorded before, but leaves those files unmerged. Stage them, so only the rest goes to the agent.
// If the agent later has to change a replayed file, that memory was wrong. git can't reliably forget one file's resolution, so wrong() drops them all.
function replay(conflicted) {
  const open = conflicted && run('git', ['rerere', 'remaining']).out
  const reused = conflicted ? conflicted.split('\n').filter((f) => !open.split('\n').includes(f)) : []
  if (reused.length) git('add', '--', ...reused)
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)
  const replayed = new Map(reused.map((f) => [f, read(f)]))
  const wrong = () => {
    const bad = reused.filter((f) => read(f) !== replayed.get(f))
    if (bad.length) fs.rmSync(git('rev-parse', '--git-path', 'rr-cache'), { recursive: true, force: true })
    else run('git', ['rerere'])
    return bad
  }
  return { open, reused, wrong }
}

const replayed = (reused) => `git already resolved ${reused.join(', ')} the way it was resolved before. Keep those resolutions unless the failure below is in them. When the check still fails, a customization usually needs adapting to an upstream change that merged without conflicts.`

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

// The prompt for each step. {{name}} is filled in when xtend runs it. `xtend config prompts` writes these out to edit.
const PROMPTS = {
  sheet: `Write a reference sheet for coding agents that will customize a private copy of this repository, at {{target}}.
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
{{hot}}

${RULES} Write only {{target}}.`,
  change: `# Ref sheet\n{{sheet}}\n\n# Request\n{{request}}\n
Make this change to the repository. Prefer new files and small, isolated edits to existing ones, so future upstream merges stay easy.
${RULES}
${SUMMARY}`,
  sync: `# Ref sheet\n{{sheet}}\n
# Task
You are merging new upstream changes into a customized copy of this project. A git merge is in progress.
Keep every upstream change AND keep every local customization working. When they collide, re-apply the local intent on top of the new upstream code.

## Local customizations (their intent, newest first)
{{ours}}

## Incoming upstream changes
{{incoming}}

## What is wrong right now
{{problem}}

${RULES} Remove all conflict markers.`,
  port: `# Ref sheet\n{{sheet}}\n
# Task
You are preparing one change from a customized fork so the upstream owner can take it. The working tree is upstream's latest code.
Re-apply this change on top of it. Leave upstream's code as it is wherever this change does not need to touch it, and bring in no other customization.

## The change
{{subject}}
{{body}}

## Its original diff
{{diff}}

## What is wrong right now
{{problem}}

${RULES} Remove all conflict markers.
${SUMMARY}`,
}

// --- get ---------------------------------------------------------------

function githubSlug(src) {
  const m = src.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m && !fs.existsSync(src) ? `${m[1]}/${m[2]}` : null
}

function get(args) {
  const daily = args.includes('--daily')
  args = args.filter((a) => a !== '--daily')
  const at = args.indexOf('--agent')
  const agent = at >= 0 ? agentCommand(args.splice(at, 2)[1] || '') : defaultAgent()
  const src = args[0]
  if (!src || !agent) throw new Fail('usage: xtend get <owner/repo | url | path> [--agent <preset or command>] [--daily]')
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
  const setup = { upstream: git('remote', 'get-url', 'upstream'), branch, agent, check: '' }

  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify(setup, null, 2) + '\n')
  const cfg = loadConfig()
  fs.copyFileSync(fileURLToPath(import.meta.url), `${DIR}/xtend.mjs`)
  git('add', '-A')
  git('commit', '-q', '-m', 'xtend: set up')

  if (fs.existsSync(OWNER_SHEET)) log(`upstream ships ${OWNER_SHEET}, using it`)
  else writeSheet(cfg)

  if (daily) setDaily(cfg, ['on'])
  else {
    pushIfFork()
    log('daily sync is off. Turn it on with: xtend daily on')
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
  const vars = { target, hot: hotFiles() || '(no history)' }
  const r = agentUntil(cfg, 'sheet', vars, () => (fs.existsSync(target) ? null : `${target} was not written`))
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
  const vars = { sheet: sheet(), request }
  const r = agentUntil(cfg, 'change', vars, () => {
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
  const { open, reused, wrong } = replay(conflicted)
  let agentRan = false
  let bad = []

  const verify = () => {
    if (!fs.existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) return 'the merge was committed or aborted; leave that to xtend'
    git('add', '-A')
    return markersLeft(conflicted) || check(cfg)
  }

  let problem
  try {
    problem = open ? `conflicts in:\n${open}` : verify()
    if (problem && reused.length) problem = `${replayed(reused)}\n\n${problem}`
    if (problem) {
      agentRan = true
      problem = resolveMerge(cfg, { ours, incoming, problem }, verify)
    }
    if (!problem) {
      bad = wrong()
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
  const kept = reused.filter((f) => !bad.includes(f))
  const fixed = conflicted.split('\n').filter((f) => f && !kept.includes(f))
  log([
    conflicted || agentRan ? 'merged upstream' : 'merged upstream cleanly',
    kept.length && `reused ${kept.length} resolution${kept.length === 1 ? '' : 's'} git remembered: ${kept.join(', ')}`,
    fixed.length && `agent resolved: ${fixed.join(', ')}`,
    agentRan && !fixed.length && 'agent fixed what the check reported',
    bad.length && 'git forgot its old resolutions, because the agent had to change them',
  ].filter(Boolean).join('; '))
  pushIfFork()
}

function resolveMerge(cfg, { ours, incoming, problem }, verify) {
  const vars = { sheet: sheet(), ours: ours || '(none recorded)', incoming, problem }
  return agentUntil(cfg, 'sync', vars, verify).problem
}

// --- share -------------------------------------------------------------

const OFFER_BRANCH = 'xtend/offer'
const OFFER_MARK = '<!-- xtend offer -->'
const MINE = ['.', ':!.xtend', ':!.github/workflows/xtend.yml']
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
      const { open, reused, wrong } = replay(conflicted)
      if (reused.length) log(`reused ${reused.length} resolution${reused.length === 1 ? '' : 's'} git remembered for "${c.subject}": ${reused.join(', ')}`)
      const verify = () => {
        if (git('rev-parse', 'HEAD') !== base) git('reset', '-q', '--soft', base)
        git('add', '-A')
        return markersLeft(conflicted) || check(cfg)
      }
      let problem = applied.ok || (conflicted && !open) ? verify() : conflicted ? `conflicts in:\n${open}` : `the diff did not apply:\n${applied.err}`
      if (problem && reused.length) problem = `${replayed(reused)}\n\n${problem}`
      if (problem) {
        const vars = { sheet: ref, subject: c.subject, body: c.body, diff: patch.toString('utf8').slice(0, 20000), problem }
        const r = agentUntil(cfg, 'port', vars, verify)
        problem = r.problem
        if (r.summary) c.body = r.summary
      }
      if (problem) throw new Fail(`could not port "${c.subject}" onto upstream:\n${problem}`)
      if (wrong().length) log('git forgot its old resolutions, because the agent had to change them')
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
    `A person picked these. xTend ported them onto your latest code with \`${cfg.steps.port.agent.value.split(' ')[0]}\`${cfg.check ? ` and ran \`${cfg.check}\`` : ''}. If you close this, xTend will not offer these changes again.`,
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
      ? `\nYour changes:\n${list.map((c) => `  ${c.n}. ${c.subject.length > 72 ? `${c.subject.slice(0, 69)}...` : c.subject} (${c.files.length} file${c.files.length === 1 ? '' : 's'}, ${c.closedBefore ? 'the owner closed it before' : c.appliesCleanly ? 'applies cleanly' : 'your agent will port it'})`).join('\n')}`
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
  log(past.open ? `updated ${past.open.url}` : `opened ${r.out}`)
}

// --- agent and the Action ---------------------------------------------

const WORKFLOW_FILE = '.github/workflows/xtend.yml'

function workflow(agent, agents) {
  const [, p] = presetOf(agent, agents)
  return `name: xtend sync
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
${p.install ? `      - run: npm i -g ${p.install}\n` : ''}      - run: |
          git config user.name "xtend"
          git config user.email "xtend@users.noreply.github.com"
          node .xtend/xtend.mjs sync
${p.key ? `        env:\n          ${p.key}: \${{ secrets.${p.key} }}\n` : ''}`
}

function actionNote(agent, repo, agents) {
  const [name, p] = presetOf(agent, agents)
  if (p.key) return `Give it a key once: gh secret set ${p.key} -R ${repo}`
  return `Add the install step and API key that ${name} needs to ${WORKFLOW_FILE}.`
}

function setDaily(cfg, [want]) {
  const on = fs.existsSync(WORKFLOW_FILE)
  if (!want) return console.log(`daily sync: ${on ? `on, in ${WORKFLOW_FILE}` : 'off. Turn it on with: xtend daily on'}`)
  if (want !== 'on' && want !== 'off') throw new Fail('usage: xtend daily [on | off]')
  const origin = run('git', ['remote', 'get-url', 'origin']).out
  if (want === 'on' && !origin) throw new Fail('daily sync runs as a GitHub Action in your fork, and this clone has no origin to push it to.')
  requireClean()
  if (want === 'on') {
    fs.mkdirSync(path.dirname(WORKFLOW_FILE), { recursive: true })
    fs.writeFileSync(WORKFLOW_FILE, workflow(actionAgent(cfg.repo), cfg.repo.agents))
    git('add', WORKFLOW_FILE)
  } else if (on) git('rm', '-q', WORKFLOW_FILE)
  if (run('git', ['diff', '--cached', '--quiet']).ok) log(`daily sync is already ${want}`)
  else git('commit', '-q', '-m', `xtend: daily sync ${want}`)
  pushIfFork()
  const repo = origin && githubSlug(origin)
  if (want === 'on' && repo && hasGh()) gh(['api', '-X', 'PUT', `repos/${repo}/actions/permissions`, '-F', 'enabled=true'])
  log(want === 'on' ? `daily sync is on. ${repo ? actionNote(actionAgent(cfg.repo), repo, cfg.repo.agents) : 'It runs once origin is on GitHub.'}` : 'daily sync is off')
}

function setAgent(cfg, spec) {
  if (!spec.length) {
    const here = [...new Set(Object.values(cfg.steps).map((s) => s.agent.value))]
    console.log(`agent: ${cfg.agent}${here.join() === cfg.agent ? '' : `\non this device: ${here.join(', ')} (see xtend config)`}\n\npresets: ${Object.keys(AGENTS).join(', ')}\nset one: xtend agent codex -m <model>, or any command that reads the prompt on stdin or from {file}`)
    return
  }
  requireClean()
  const agent = agentCommand(spec.join(' '), cfg.repo.agents)
  fs.writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), agent }, null, 2) + '\n')
  if (fs.existsSync(WORKFLOW_FILE)) fs.writeFileSync(WORKFLOW_FILE, workflow(actionAgent(cfg.repo, agent), cfg.repo.agents))
  git('add', '-A')
  git('commit', '-q', '-m', `xtend: use ${presetOf(agent, cfg.repo.agents)[0]} as the agent`)
  log(`agent is now: ${agent}`)
  const own = Object.entries(cfg.repo.steps || {}).filter(([, st]) => st.agent).map(([name]) => name)
  if (own.length) log(`${own.join(', ')} keep${own.length === 1 ? 's' : ''} its own agent from ${CONFIG}`)
  const repo = fs.existsSync(WORKFLOW_FILE) && githubSlug(git('remote', 'get-url', 'origin'))
  if (repo) log(actionNote(actionAgent(cfg.repo, agent), repo, cfg.repo.agents))
  pushIfFork()
}

// --- config ------------------------------------------------------------

function config(args) {
  if (args[0] === 'prompts') return exportPrompts(args.slice(1))
  if (args.length && args.join() !== '--json') throw new Fail('usage: xtend config [--json] | xtend config prompts [<step>...]')
  const cfg = loadConfig(false)
  const steps = Object.fromEntries(Object.entries(cfg.steps).map(([name, s]) => [name, Object.fromEntries(STEP_KEYS.filter((k) => s[k]).map((k) => [k, { value: s[k].value, from: s[k].from }]))]))
  const check = { value: cfg.check, from: cfg.checkFrom || 'xtend' }
  if (args[0] === '--json') return console.log(JSON.stringify({ files: { repo: path.resolve(CONFIG), device: deviceFile() }, check, steps }, null, 2))
  const local = (v) => (v.from === CONFIG || v.from === 'xtend' ? '' : ', not seen by the daily Action')
  const line = (k, v) => `  ${k.padEnd(7)}${v.value === '' ? '(none)' : v.value}  (${v.from}${local(v)})`
  console.log(`later wins: xtend, ${CONFIG}, this device (${deviceFile()}), XTEND_AGENT\n\n${line('check', check)}`)
  for (const [name, s] of Object.entries(steps)) console.log(`\n${name}\n${Object.entries(s).map(([k, v]) => line(k, v)).join('\n')}`)
}

// Writes xtend's prompts next to this device's config.json and points it at them, so editing a file changes that step.
function exportPrompts(names) {
  names = names.length ? names : Object.keys(PROMPTS)
  const unknown = names.filter((n) => !PROMPTS[n])
  if (unknown.length) throw new Fail(`there is no step ${unknown.join(', ')}. Steps: ${Object.keys(PROMPTS).join(', ')}`)
  const file = deviceFile()
  const data = fs.existsSync(file) ? readJson(file) : {}
  fs.mkdirSync(path.join(path.dirname(file), 'prompts'), { recursive: true })
  for (const name of names) {
    const out = path.join(path.dirname(file), 'prompts', `${name}.md`)
    if (fs.existsSync(out)) log(`kept ${out}`)
    else { fs.writeFileSync(out, PROMPTS[name]); log(`wrote ${out}`) }
    data.steps ??= {}
    data.steps[name] = { prompt: `prompts/${name}.md`, ...data.steps[name] }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  log(`${file} uses them now. Edit them freely; {{name}} is filled in when the step runs.`)
}

// --- main --------------------------------------------------------------

const [verb, ...rest] = process.argv.slice(2)
try {
  if (!verb || verb === 'help' || verb === '-h' || verb === '--help') console.log(HELP)
  else if (verb === 'get') get(rest)
  else if (verb === 'agent') setAgent(loadConfig(), rest)
  else if (verb === 'daily') setDaily(loadConfig(), rest)
  else if (verb === 'sync') sync(loadConfig())
  else if (verb === 'share') share(loadConfig(), rest)
  else if (verb === 'sheet') writeSheet(loadConfig(false))
  else if (verb === 'config') config(rest)
  else change(loadConfig(), [verb, ...rest].join(' '))
} catch (e) {
  if (!(e instanceof Fail)) throw e
  console.error(`xtend: ${e.message}`)
  process.exitCode = 1
}
