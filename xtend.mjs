#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
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
  claude: { cmd: 'claude -p --allowedTools "Edit,Write,Bash(git rm:*),Bash(git mv:*)"', install: '@anthropic-ai/claude-code', key: 'ANTHROPIC_API_KEY' },
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
      [--private]                       keep it in a new private repo of yours instead of a public fork
      [--origin <url>]                  or keep it in an empty repo you already made
      [--replace]                       with --origin: the repo has a starter commit (README, license); replace it
      [--name <name>]                   call your copy something else, e.g. --name mcode
  xtend "<what you want>"               your agent makes the change and commits it
  xtend fix "<what is broken>"          like a change, but temporary: a stopgap for something upstream will fix
      [--proof "<command>"]             passes once the stopgap is not needed; lets sync drop it for you
  xtend temp [--try]                    list the temporary fixes you still carry; --try drops the ones no longer needed
  xtend temp --proof <commit> "<cmd>"   give a temporary fix a new proof, when its old one no longer runs
  xtend commit "<what you wanted>"      record a change an agent already made itself: run the check, commit, push
      [-m "<what changed and why>"]     the body later merges read to keep the change working
      [--temp] [--proof "<command>"]    record it as a temporary fix, as xtend fix does
      [-- <path>...]                    only these files; without it, everything changed
  xtend status [--json] [--no-fetch]    where this copy stands: behind and ahead, seams, temporary fixes, the last sync
  xtend seam <file> "<text>" [-m why]   record a line of upstream's that your changes hang on; every check looks for it
  xtend seam --drop <file> "<text>"     stop tracking one
  xtend seams                           list them, and say which are gone
  xtend names [--json]                  new lines from the last sync that use a name this copy changed ("renamed" in the config)
  xtend before "<command>"              run a command on this copy as it was before the sync, to tell whose failure it is
      [--at <commit>]                   or as it was at another commit
  xtend before --done                   remove the checkout that command keeps beside this one
  xtend sync                            merge upstream; your agent resolves conflicts
  xtend sync --root                     merge the root instead: the repo your upstream was itself forked from
  xtend sync --prompt                   merge upstream; print what is left for an agent that resolves it itself
  xtend sync --continue | --abort       finish or drop a sync that --prompt left open
      [-m "<what you decided>"]         with --continue: the merge commit's body, for whoever merges next
  xtend sheet                           (re)write the ref sheet agents read before editing
  xtend sheet --prompt                  print what the sheet step asks, for an agent that writes it itself
  xtend share [--json]                  what upstream accepts, and which of your changes you could offer
  xtend share <n>... [--yes]            offer those changes upstream, the way the owner asks for them
  xtend agent [preset or command]       show or change the agent, e.g. \`xtend agent codex -m gpt-6\`
  xtend agent none                      no agent: a clean sync lands by itself, any other changes nothing and says so
  xtend daily [on | off]                show, add or remove the GitHub Action that runs xtend sync every day
  xtend update                          refresh the copy of xtend this repo carries in .xtend/, for the daily Action
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
// A merge can leave more paths than one command line holds, so a long list goes to git a batch at a time.
function batches(paths, room = 100_000) {
  const out = [[]]
  let size = 0
  for (const p of paths) {
    if (size + p.length > room && out.at(-1).length) { out.push([]); size = 0 }
    out.at(-1).push(p)
    size += p.length + 1
  }
  return out.filter((b) => b.length)
}
const gh = (args, opts) => (process.env.XTEND_GH ? run(process.execPath, [process.env.XTEND_GH, ...args], opts) : run('gh', args, opts))
const hasGh = () => !!process.env.XTEND_GH || has('gh')
const has = (bin) => run(process.platform === 'win32' ? 'where' : 'which', [bin]).ok
const log = (msg) => console.log(`xtend: ${msg}`)
// Some agent CLIs, opencode among them, work in $PWD rather than the directory they start in, so PWD has to match it.
const withPwd = () => ({ ...process.env, PWD: process.cwd() })

function shell(cmd, input) {
  const file = cmd.includes('{file}') && path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xtend-')), 'prompt.md')
  if (file) fs.writeFileSync(file, input)
  try {
    const r = spawnSync(file ? cmd.replaceAll('{file}', JSON.stringify(file)) : cmd, { shell: true, env: withPwd(), input: file ? '' : input, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'inherit'] })
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
      const own = name && l.data.steps?.[name]?.[key]
      const v = own ?? (key === 'prompt' ? undefined : l.data[key])
      if (v !== undefined && v !== '') return { value: v, from: l.from, file: l.file, top: own == null }
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
      agent: { ...agent, value: agent.from === CONFIG && agent.top ? String(agent.value) : agentCommand(String(agent.value), agents) },
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
  return repo.steps?.sync?.agent ? agentCommand(String(repo.steps.sync.agent), repo.agents) : agent
}

function sheet() {
  for (const f of [OWNER_SHEET, FORK_SHEET]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8')
  return '(no ref sheet yet)'
}

const syncState = () => git('rev-parse', '--git-path', 'xtend-sync.json')
const fileHash = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)

function requireClean() {
  if (fs.existsSync(syncState())) throw new Fail('a sync is waiting to be finished. Run `xtend sync --continue`, or `xtend sync --abort` to drop it.')
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Fail('working tree has uncommitted changes. Commit or stash them first.')
}

// The branch this copy is kept on can gain commits on origin while a sync is open: someone pushed, or another session did. What it
// gained is in neither side of the merge, so a merge finished here and checked here says nothing about it. One ls-remote when it has not moved.
function originAhead() {
  if (!tryGit('remote', 'get-url', 'origin')) return null
  const head = run('git', ['ls-remote', '--symref', 'origin', 'HEAD'])
  const branch = head.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1]
  const sha = head.out.match(/^([0-9a-f]{40,})\s+HEAD$/m)?.[1]
  if (!head.ok || !branch || !sha || tryGit('merge-base', '--is-ancestor', sha, 'HEAD')) return null
  if (!run('git', ['fetch', '-q', 'origin', branch]).ok) return null
  const commits = Number(git('rev-list', '--count', `HEAD..${sha}`))
  return commits ? { branch, commits } : null
}
const originNote = (o) => `origin's ${o.branch} has ${plural(o.commits, 'commit')} this checkout does not have. Bring them in with \`git pull --no-rebase origin ${o.branch}\`, and run your checks again after: what passed before says nothing about them.`

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
function promptFor(cfg, step, vars) {
  const { prompt: source, template, add } = cfg.steps[step]
  return render(template, vars, source.file ? source.value : `the built-in ${step} prompt`) + (add ? `\n\n${add.value}` : '')
}

const NO_AGENT = 'none'

function agentUntil(cfg, step, vars, verify) {
  const { agent, after, tries } = cfg.steps[step]
  if (agent.value === NO_AGENT) return { problem: `no agent is set for this step (agent: ${NO_AGENT}). Do it yourself: edit the files, then record the change with \`xtend commit\`.` }
  const prompt = promptFor(cfg, step, vars)
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

function command(cmd, cwd = process.cwd()) {
  const r = spawnSync(cmd, { shell: true, cwd, env: { ...process.env, PWD: cwd }, encoding: 'utf8', maxBuffer: 64 << 20 })
  return r.status === 0 ? null : `\`${cmd}\` failed:\n${`${r.stdout}\n${r.stderr}`.trim().slice(-4000)}`
}

// A seam is a line in one of upstream's files that a change of yours hangs on: the call, import or list entry that hooks it in. Upstream can
// rewrite around it and the merge stays clean, with your feature silently unhooked. So every check looks for each seam before it runs anything.
const seamHeld = (s) => fs.existsSync(s.file) && fs.readFileSync(s.file, 'utf8').includes(s.has)
const seamsGone = (cfg) => (cfg.seams || []).filter((s) => !seamHeld(s))
const seamLine = (s) => `${s.file} no longer has \`${s.has}\`${s.why ? `, which ${s.why}` : ''}`
function check(cfg) {
  const gone = seamsGone(cfg)
  if (gone.length) return `${gone.length === 1 ? 'a seam is' : 'seams are'} gone:\n${gone.map((s) => `- ${seamLine(s)}`).join('\n')}\nPut each back where upstream's new code calls for it. If one is no longer needed, drop it with \`xtend seam --drop <file> "<text>"\`.`
  return cfg.check ? command(cfg.check) : null
}
// prepare runs once a merge is in the tree, before anything is checked: new upstream code often needs its dependencies installed first.
// verify runs after the check, on a sync only. It is the place for what is too slow to run on every commit, such as a typecheck or a build.
const prepare = (cfg) => (cfg.prepare ? command(cfg.prepare) : null)
// `runs` are the commands that rebuild generated files this merge disturbed. They come after prepare, since a generator needs its
// dependencies, and what they and prepare write (a rebuilt catalog, a lockfile the installer brought up to date) belongs to the merge.
function checkMerge(cfg, runs = []) {
  const unready = prepare(cfg) || runs.map((cmd) => command(cmd)).find(Boolean)
  if (unready) return unready
  if (cfg.prepare || runs.length) git('add', '-A')
  return check(cfg) || (cfg.verify ? command(cfg.verify) : null)
}

// --- conflicts that settle by rule -------------------------------------

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'flake.lock'])
const MERGES = ['json', 'theirs', 'ours']

// "generated" in the config names files a command writes, with * for any run of characters. A plain name only tells status the file needs
// no seam. { files, merge, run } also says how a conflict in it settles: merge is json (key by key), theirs or ours, and run rebuilds it after.
function generatedRules(cfg) {
  return (cfg.generated || []).map((g) => (typeof g === 'string' ? { files: g } : g)).map((g) => {
    if (typeof g.files !== 'string' || (g.merge && !MERGES.includes(g.merge))) throw new Fail(`${CONFIG}: a generated entry is a file pattern, or { "files": "<pattern>", "merge": "${MERGES.join(' | ')}", "run": "<command>" }`)
    return { ...g, test: new RegExp(`^${g.files.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) }
  })
}

// Two sides of a JSON file mostly conflict as text because both added keys side by side. Key by key there is nothing to decide:
// take whichever side changed each key. Null when both sides changed the same key differently, which is for someone to judge.
function mergeJson(base, ours, theirs) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const walk = (b, o, t) => {
    if (same(o, t) || same(t, b)) return { value: o }
    if (same(o, b)) return { value: t }
    if (!isObj(o) || !isObj(t)) return null
    // Upstream's order, with each key of ours that upstream lacks placed after the key it follows on our side.
    const keys = Object.keys(t)
    Object.keys(o).forEach((k, i, all) => {
      if (k in t) return
      const after = all.slice(0, i).reverse().find((prev) => keys.includes(prev))
      keys.splice(after === undefined ? 0 : keys.indexOf(after) + 1, 0, k)
    })
    const out = {}
    for (const k of keys) {
      const r = walk(isObj(b) ? b[k] : undefined, o[k], t[k])
      if (!r) return null
      if (r.value !== undefined) out[k] = r.value
    }
    return { value: out }
  }
  return walk(base, ours, theirs)
}

const staged = (stage, file) => spawnSync('git', ['show', `:${stage}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
const jsonShape = (text) => ({ indent: text.match(/^([ \t]+)"/m)?.[1] ?? 2, end: text.endsWith('\n') ? '\n' : '' })

const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || []

// What the other side wrote where this side cut a block, in two kinds. Lines it put in before the first line the two versions share,
// or after the last, with nothing of the block changed on that side of them, sit beside the block: new code that landed next to it.
// Every other line of its own, added between the block's lines or written over one of them, is `inside`. Those may be the block, edited.
function addedAroundCut(base, theirs) {
  const b = linesOf(base)
  const t = linesOf(theirs)
  const none = { before: '', after: '', inside: t.filter((l) => l.trim()) }
  if (!b.length || !t.length || b.length * t.length > 4e6) return none
  // Longest common subsequence, walked from the top, so each line pairs with the earliest match that keeps the rest.
  const len = Array.from({ length: b.length + 1 }, () => new Uint32Array(t.length + 1))
  for (let i = b.length - 1; i >= 0; i--) for (let j = t.length - 1; j >= 0; j--) len[i][j] = b[i] === t[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1])
  const pairs = []
  for (let i = 0, j = 0; i < b.length && j < t.length; ) {
    if (b[i] === t[j]) pairs.push([i++, j++])
    else if (len[i + 1][j] >= len[i][j + 1]) i++
    else j++
  }
  if (!pairs.length) return none
  const said = (lines) => lines.some((l) => l.trim())
  const [first, last] = [pairs[0], pairs[pairs.length - 1]]
  const before = first[0] === 0 ? t.slice(0, first[1]) : []
  const after = last[0] === b.length - 1 ? t.slice(last[1] + 1) : []
  const kept = [said(before) ? before : [], said(after) ? after : []]
  const shared = new Set(pairs.map(([, j]) => j))
  const inside = t.filter((l, j) => !shared.has(j) && j >= kept[0].length && j < t.length - kept[1].length && l.trim())
  return { before: kept[0].join(''), after: kept[1].join(''), inside }
}

// Settles the conflicts that need no judgment, right after the merge and before anyone is asked:
// - a file this side deleted and the other side went on editing stays deleted, since deleting it was the decision, and so does a
//   block of lines this side cut out of a file, while lines the other side added beside that block are kept;
// - a lockfile, or a generated file the config says so for, is taken whole from one side, to be rebuilt by prepare or its own command;
// - a JSON file is merged key by key: any the config names, and any other whose layout xtend can write back exactly as it was.
function settle(cfg) {
  const rules = generatedRules(cfg)
  const stages = new Map()
  for (const line of git('ls-files', '-u').split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t')
    stages.set(file, (stages.get(file) || new Set()).add(Number(meta.split(' ')[2])))
  }
  const done = { kept: [], merged: [], taken: [], cut: [], beside: [], inside: [], runs: [] }
  const used = new Set()
  const settled = new Set()
  for (const [file, has] of stages) {
    if (!has.has(2) && has.has(3)) {
      git('rm', '-q', '-f', '--', file)
      done.kept.push(file)
      settled.add(file)
      continue
    }
    if (!has.has(2) || !has.has(3)) continue
    const rule = rules.find((r) => r.merge && r.test.test(file))
    const how = rule?.merge ?? (LOCKFILES.has(path.basename(file)) ? 'theirs' : file.endsWith('.json') ? 'json' : null)
    if (how === 'theirs' || how === 'ours') {
      git('checkout', `--${how}`, '--', file)
      git('add', '--', file)
      done.taken.push(file)
    } else if (how === 'json') {
      const [b, o, t] = [1, 2, 3].map((n) => (has.has(n) ? staged(n, file).stdout : '{}'))
      let merged
      try {
        const shape = jsonShape(o)
        // Unnamed files are merged only when writing ours back gives the same bytes, so the merge cannot reformat a file nobody asked it to.
        if (!rule && JSON.stringify(JSON.parse(o), null, shape.indent) + shape.end !== o) continue
        merged = mergeJson(JSON.parse(b), JSON.parse(o), JSON.parse(t))
        if (!merged) continue
        fs.writeFileSync(file, JSON.stringify(merged.value, null, shape.indent) + shape.end)
      } catch {
        continue
      }
      git('add', '--', file)
      done.merged.push(file)
    } else continue
    settled.add(file)
    if (rule) used.add(rule)
  }
  // The same decision inside a file: a block this side cut out, which the other side went on editing, stays cut. Shown with the common
  // ancestor, a conflict whose "ours" half is empty is exactly that. Files git has already resolved from memory are left to that memory.
  // The conflict also takes in whatever the other side added right next to the block. That is not an edit to what was cut, so it stays,
  // and is listed for whoever finishes the sync: cutting it too would lose new upstream code without a word.
  const open = new Set(run('git', ['rerere', 'remaining']).out.split('\n'))
  const hunk = /^<<<<<<< [^\n]*\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]*\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm
  for (const [file, has] of stages) {
    if (settled.has(file) || !open.has(file) || [1, 2, 3].some((n) => !has.has(n))) continue
    if (!run('git', ['checkout', '--conflict=diff3', '--', file]).ok) continue
    let blocks = 0
    let left = 0
    const text = fs.readFileSync(file, 'utf8')
    const out = text.replace(hunk, (all, ours, base, theirs) => {
      if (ours !== '' || base.trim() === '') return left++, all
      blocks++
      const added = addedAroundCut(base, theirs)
      for (const l of linesOf(added.before + added.after)) if (l.trim()) done.beside.push(`${file}: ${l.trim()}`)
      for (const l of added.inside) done.inside.push(`${file}: ${l.trim()}`)
      return added.before + added.after
    })
    if (!blocks) {
      run('git', ['checkout', '--conflict=merge', '--', file])
      continue
    }
    fs.writeFileSync(file, out)
    if (!left) git('add', '--', file)
    done.cut.push(blocks === 1 ? file : `${file} (${blocks})`)
  }
  done.runs = [...new Set(rules.filter((r) => used.has(r) && r.run).map((r) => r.run))]
  return done
}

const some = (files) => (files.length > 6 ? `${files.slice(0, 6).join(', ')} and ${files.length - 6} more` : files.join(', '))
const listed = (lines, max = 200) => [...lines.slice(0, max), ...(lines.length > max ? [`and ${lines.length - max} more`] : [])].map((l) => `\n    ${l}`).join('')
const settledLines = (done) => [
  done.kept.length && `kept ${plural(done.kept.length, 'file')} deleted that the other side had gone on editing: ${some(done.kept)}`,
  done.cut.length && `kept blocks cut out that the other side had gone on editing, in ${plural(done.cut.length, 'file')}: ${some(done.cut)}`,
  done.beside.length && `kept ${plural(done.beside.length, 'line')} the other side added beside those blocks. Check each belongs in this copy:${listed(done.beside)}`,
  done.inside.length && `left out ${plural(done.inside.length, 'line')} the other side wrote inside those blocks. Put back any that is not part of what was cut:${listed(done.inside)}`,
  done.merged.length && `merged ${plural(done.merged.length, 'JSON file')} key by key: ${some(done.merged)}`,
  done.taken.length && `took one side's copy of ${plural(done.taken.length, 'generated file')}, to be rebuilt: ${some(done.taken)}`,
  done.runs.length && `rebuilt them with: ${done.runs.join(' && ')}`,
].filter(Boolean)

// rerere replays resolutions it recorded before, but leaves those files unmerged. Stage them, so only the rest goes to the agent.
// If the agent later has to change a replayed file, that memory was wrong. git can't reliably forget one file's resolution, so wrong() drops them all.
function replay(conflicted) {
  const open = conflicted && run('git', ['rerere', 'remaining']).out
  const reused = conflicted ? conflicted.split('\n').filter((f) => !open.split('\n').includes(f)) : []
  for (const some of batches(reused)) git('add', '--', ...some)
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
    ...(conflicted ? batches(conflicted.split('\n')).map((some) => run('git', ['grep', '--cached', '-lE', '^=======[[:space:]]*$', '--', ...some]).out) : []),
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
A customization whose message has an Xtend-Temporary line is a stopgap for something that was broken upstream. Where the incoming changes fix the same thing, take upstream's code and leave the stopgap out.

## Local customizations (their intent, newest first)
{{ours}}

## Incoming upstream changes
{{incoming}}

## Seams (lines in upstream's files that the customizations hang on; each must still be there when you finish)
{{seams}}

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

function remoteHeads(url) {
  const r = run('git', ['ls-remote', '--heads', url])
  if (!r.ok) throw new Fail(`cannot reach ${url}:\n${r.err || r.out}`)
  return Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => l.split(/\s+/).reverse()).map(([ref, sha]) => [ref.replace('refs/heads/', ''), sha]))
}

// The starter commit stays reachable on replaced-<branch>, and the lease refuses if anyone pushed since get looked.
function replaceStarter(branch, sha) {
  git('fetch', '-q', 'origin', branch)
  git('push', '-q', 'origin', `${sha}:refs/heads/replaced-${branch}`)
  git('push', '-q', `--force-with-lease=${branch}:${sha}`, 'origin', `HEAD:${branch}`)
  log(`replaced the starter commit on ${branch}; it is kept on replaced-${branch}`)
}

// A copy in your own repo inherits every workflow upstream ships: its CI, releases and deploys would run on your account.
function quietWorkflows() {
  const dir = path.dirname(WORKFLOW_FILE)
  const theirs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== path.basename(WORKFLOW_FILE)) : []
  if (!theirs.length) return
  const origin = run('git', ['remote', 'get-url', 'origin']).out
  const repo = origin && githubSlug(origin)
  const off = repo && hasGh() ? theirs.filter((f) => gh(['workflow', 'disable', f, '-R', repo]).ok) : []
  const left = theirs.length - off.length
  if (off.length) log(`turned off ${off.length} workflow${off.length === 1 ? '' : 's'} that came from upstream, so they do not run on your account. Turn one back on with: gh workflow enable <file>`)
  if (left) log(`upstream ships ${left} workflow${left === 1 ? '' : 's'} in ${dir} that ${left === 1 ? 'is' : 'are'} still on. On GitHub they run in your copy, on your account: turn Actions off in the repo's settings, or turn each off with \`gh workflow disable <file>\`.`)
}

function get(args) {
  const daily = args.includes('--daily')
  const priv = args.includes('--private')
  args = args.filter((a) => a !== '--daily' && a !== '--private')
  const at = args.indexOf('--agent')
  const agent = at >= 0 ? agentCommand(args.splice(at, 2)[1] || '') : defaultAgent()
  const nameAt = args.indexOf('--name')
  const named = nameAt >= 0 ? args.splice(nameAt, 2)[1] || '' : null
  const originAt = args.indexOf('--origin')
  const origin = originAt >= 0 ? args.splice(originAt, 2)[1] || '' : null
  const replace = args.includes('--replace')
  args = args.filter((a) => a !== '--replace')
  const src = args[0]
  if (args.length > 1) throw new Fail(`${args.slice(1).join(' ')} is not read. Quote the agent with its flags, like --agent "codex -m gpt-6"`)
  if (!src || !agent) throw new Fail('usage: xtend get <owner/repo | url | path> [--agent <preset or command>] [--daily] [--private | --origin <url> [--replace]] [--name <name>]')
  if (named !== null && !/^[\w.-]+$/.test(named)) throw new Fail('--name takes one name of letters, digits, dots, dashes and underscores, like --name mcode')
  if (origin !== null && (!origin || origin.startsWith('--'))) throw new Fail('--origin takes the URL of an empty repo of yours, like --origin https://github.com/you/mcode.git')
  if (origin && priv) throw new Fail('--private creates the repo and --origin uses one you made. Pick one.')
  if (replace && !origin) throw new Fail('--replace goes with --origin: it replaces the starter commit of a repo you made.')
  // Asked before cloning, so a repo that is unreachable or not empty costs seconds instead of a full clone and a rejected push.
  const starter = origin ? remoteHeads(origin) : {}
  if (Object.keys(starter).length && !replace) throw new Fail(`${origin} is not empty: it has ${Object.keys(starter).join(', ')}. GitHub adds a commit when you tick "Add a README" or pick a license.\nUse an empty repo, or add --replace: xtend keeps what is there on a replaced-<branch> branch and puts your copy in its place.`)
  const slug = githubSlug(src)
  const name = named || path.basename(slug || src).replace(/\.git$/, '')
  if (fs.existsSync(name)) throw new Fail(`${name} already exists`)
  // GitHub gives a fork its parent's visibility, so a fork of a public repo is public. A private copy is a repo of its own that tracks upstream by remote.
  if (priv && !hasGh()) throw new Fail('--private creates a private GitHub repo, which needs the gh CLI. Install gh, or drop --private and add your own origin.')
  if (daily && !((slug || priv || origin) && hasGh())) throw new Fail('--daily needs a GitHub fork, so a GitHub repo and the gh CLI. Drop --daily, or install gh.')

  if (slug && hasGh() && !priv && !origin) {
    log(`forking ${slug} on GitHub`)
    const r = gh(['repo', 'fork', slug, '--clone', '--default-branch-only', ...(named ? ['--fork-name', name] : [])], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (!r.ok) throw new Fail('gh repo fork failed')
  } else {
    git('clone', slug ? `https://github.com/${slug}.git` : src, name)
    git('-C', name, 'remote', 'rename', 'origin', 'upstream')
  }
  process.chdir(name)

  tryGit('remote', 'set-head', 'upstream', '--auto')
  const branch = git('rev-parse', '--abbrev-ref', 'upstream/HEAD').replace(/^upstream\//, '')
  if (priv) {
    log(`creating private repo ${name} on GitHub`)
    const r = gh(['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin'], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (!r.ok || !tryGit('remote', 'get-url', 'origin')) {
      process.chdir('..')
      fs.rmSync(name, { recursive: true, force: true })
      throw new Fail(`gh repo create failed, so ./${name} was removed. Check \`gh auth status\` and that you have no repo called ${name} yet, then run it again.`)
    }
  } else if (origin) git('remote', 'add', 'origin', origin)
  // The clone tracked upstream, so a plain \`git push\` would have gone to the owner's repo.
  if (priv || origin) git('config', `branch.${git('rev-parse', '--abbrev-ref', 'HEAD')}.remote`, 'origin')
  const setup = { upstream: git('remote', 'get-url', 'upstream'), branch, agent, check: '' }

  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify(setup, null, 2) + '\n')
  const cfg = loadConfig()
  fs.copyFileSync(fileURLToPath(import.meta.url), `${DIR}/xtend.mjs`)
  git('add', '-A')
  git('commit', '-q', '-m', 'xtend: set up')

  // The clone and its set-up are done by now. A sheet the agent could not write is no reason to leave them unpushed.
  if (fs.existsSync(OWNER_SHEET)) log(`upstream ships ${OWNER_SHEET}, using it`)
  else {
    try {
      writeSheet(cfg)
    } catch (e) {
      if (!(e instanceof Fail)) throw e
      git('reset', '-q', '--hard')
      log(`${e.message}\nThere is no ref sheet yet. Check the agent with \`xtend agent\`, then run \`xtend sheet\`.`)
      process.exitCode = 1
    }
  }

  if (starter[branch]) replaceStarter(branch, starter[branch])
  if (daily) setDaily(cfg, ['on'])
  else {
    pushIfFork()
    if (priv || origin) quietWorkflows()
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

function writeSheet(cfg, args = []) {
  if (args.length && args.join() !== '--prompt') throw new Fail('usage: xtend sheet [--prompt]')
  const target = fs.existsSync(CONFIG) ? FORK_SHEET : OWNER_SHEET
  const vars = { target, hot: hotFiles() || '(no history)' }
  // For an agent that is already working in this repo and cannot start another one: it follows the prompt itself, then commits the sheet.
  if (args.length) return console.log(promptFor(cfg, 'sheet', vars))
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

function change(cfg, request, trailers = '') {
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
  git('commit', '-q', '-m', `xtend: ${request}`, '-m', withTrailers(r.summary || request, trailers))
  log(trailers ? 'committed as a temporary fix' : 'committed')
  pushIfFork()
}

function fix(cfg, args) {
  const proofAt = args.indexOf('--proof')
  const proof = proofAt >= 0 ? args.splice(proofAt, 2)[1] || '' : ''
  const request = args.join(' ').trim()
  if (!request || (proofAt >= 0 && !proof)) throw new Fail('usage: xtend fix "<what is broken>" [--proof "<command that passes once the fix is not needed>"]')
  change(cfg, request, tempTrailers(true, proof))
}

// --- temporary fixes ---------------------------------------------------

// A temporary fix is a change you expect to throw away: a stopgap for something upstream will fix. It is an ordinary commit with an
// Xtend-Temporary trailer. A commit with Xtend-Retires: <sha> ends it, so history is never rewritten.
const TEMP = 'Xtend-Temporary'
const PROOF = 'Xtend-Proof'
const RETIRES = 'Xtend-Retires'
const REPROVES = 'Xtend-Reproves'

function tempTrailers(temp, proof) {
  if (proof && /\n/.test(proof)) throw new Fail('--proof takes one command on one line')
  return temp || proof ? [`${TEMP}: yes`, proof && `${PROOF}: ${proof}`].filter(Boolean).join('\n') : ''
}

// Keeps trailers the caller already put at the end of the body in the same block as xtend's, so git reads them all.
function withTrailers(body, trailers) {
  if (!trailers) return body
  const last = body.split(/\n\n/).pop()
  const isBlock = body.includes('\n\n') && last.split('\n').every((l) => /^[\w-]+: /.test(l))
  return `${body}${isBlock ? '\n' : '\n\n'}${trailers}`
}

const ROOT_REF = 'refs/xtend/root'
const hasRef = (ref) => tryGit('rev-parse', '--verify', '-q', ref)
const repoUrl = (src) => (/^[\w.-]+\/[\w.-]+$/.test(src) && !fs.existsSync(src) ? `https://github.com/${src}` : src)
const fetchRoot = (cfg) => run('git', ['fetch', '-q', repoUrl(cfg.root), `+${cfg.rootBranch || cfg.branch}:${ROOT_REF}`]).ok
// What this copy takes in: upstream, and the root once it has been fetched. A copy can merge from both, so its own changes are
// whatever a commit has beyond the two of them, never "ahead of upstream" alone.
const sources = (cfg) => [`upstream/${cfg.branch}`, ...(cfg.root ? [ROOT_REF] : [])].filter(hasRef)
const ownRange = (cfg, tip = 'HEAD') => [tip, '--not', ...sources(cfg)]
// A shallow clone has no history before the point it was cut at. When that point lies inside this copy's own commits, the commit there
// has no parent to compare with: it looks as if it added every file, and there is nothing shared with upstream to merge from.
function cutShort(cfg) {
  const file = git('rev-parse', '--git-path', 'shallow')
  const cut = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
  return cut.size > 0 && git('rev-list', ...ownRange(cfg)).split('\n').some((sha) => cut.has(sha))
}
const DEEPEN = 'Fetch the rest of its history first: `git fetch --unshallow origin`, or a deeper `git fetch --depth=<n> origin <branch>` where the whole of it is too much.'

function tempFixes(cfg) {
  const trailer = (key) => `%(trailers:key=${key},valueonly,separator=%x20)`
  const rows = git('log', '--no-merges', '--reverse', `--format=%H%x1f%s%x1f${trailer(TEMP)}%x1f${trailer(PROOF)}%x1f${trailer(RETIRES)}%x1f${trailer(REPROVES)}%x1e`, ...ownRange(cfg))
    .split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => r.split('\x1f').map((c) => c.trim()))
  const retired = new Set(rows.flatMap((r) => (r[4] || '').split(/\s+/).filter(Boolean)))
  // A later `xtend temp --proof` replaces the proof the fix was committed with.
  const reproved = new Map(rows.filter((r) => r[5]).map((r) => [r[5], r[3]]))
  const live = rows.filter(([sha, , temp]) => temp && !retired.has(sha)).map(([sha, subject, , proof]) => ({
    sha,
    subject: subject.replace(/^xtend: /, ''),
    proof: reproved.get(sha) ?? proof,
    files: git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean),
  }))
  // A retired fix and the commit that retired it cancel out, so neither counts as a local change any more.
  live.settled = new Set([...retired, ...rows.filter((r) => r[4] || r[5]).map((r) => r[0])])
  return live
}

const sameAsUpstream = (cfg, files) => sources(cfg).some((ref) => run('git', ['diff', '--quiet', ref, 'HEAD', '--', ...files]).ok)

// Ends the fixes that are no longer needed. One whose files now match upstream is over. One with a proof is reverted, and stays reverted
// only if its proof and the check pass without it. Without a proof xtend cannot tell, so the fix stays until its files match upstream.
function retireTemps(cfg, fixes) {
  for (const fix of fixes) {
    const end = (subject, body) => git('commit', '-q', '--allow-empty', '-m', `xtend: ${subject}: ${fix.subject}`, '-m', `${body}\n\n${RETIRES}: ${fix.sha}`)
    if (sameAsUpstream(cfg, fix.files)) {
      end('retire temporary fix', "Upstream's code is in place where this fix was.")
      log(`retired temporary fix "${fix.subject}": upstream's code is in its place`)
      continue
    }
    if (!fix.proof) continue
    // A proof that fails with the fix in place has stopped measuring the fix, so it would keep the fix forever.
    if (command(fix.proof)) {
      log(`temporary fix "${fix.subject}" has a proof that fails even with the fix in place, so it cannot say whether the fix is still needed: ${fix.proof}\n  if something else broke it (a sync often does), fix that and run: xtend temp --try\n  if the proof itself no longer runs, give the fix a new one: xtend temp --proof ${fix.sha.slice(0, 10)} "<command>"`)
      continue
    }
    const head = git('rev-parse', 'HEAD')
    const undo = () => {
      run('git', ['revert', '--quit'])
      git('reset', '-q', '--hard', head)
      git('clean', '-qfd')
    }
    if (!run('git', ['revert', '--no-commit', fix.sha]).ok || !git('diff', '--cached', '--name-only') || command(fix.proof) || check(cfg)) {
      undo()
      continue
    }
    run('git', ['revert', '--quit'])
    end('drop temporary fix', `Its proof passes without it now: ${fix.proof}`)
    log(`dropped temporary fix "${fix.subject}": its proof passes without it`)
  }
}

function reprove(cfg, [sha, proof]) {
  if (!sha || !proof) throw new Fail('usage: xtend temp --proof <commit> "<command>"')
  requireClean()
  const fix = tempFixes(cfg).filter((f) => f.sha.startsWith(sha))
  if (fix.length !== 1) throw new Fail(`${fix.length ? 'more than one' : 'no'} temporary fix starts with ${sha}. \`xtend temp\` lists them.`)
  const failed = command(proof)
  if (failed) throw new Fail(`the proof has to pass with the fix in place.\n${failed}`)
  git('commit', '-q', '--allow-empty', '-m', `xtend: new proof for temporary fix: ${fix[0].subject}`, '-m', `${REPROVES}: ${fix[0].sha}\n${PROOF}: ${proof}`)
  pushIfFork()
  log(`temporary fix "${fix[0].subject}" is now proved by: ${proof}`)
}

function temp(cfg, args) {
  if (args[0] === '--proof') {
    if (args.length !== 3) throw new Fail('usage: xtend temp --proof <commit> "<command>"')
    if (!tryGit('rev-parse', '--verify', '-q', `upstream/${cfg.branch}`)) throw new Fail('upstream has not been fetched yet. Run `xtend sync` first.')
    return reprove(cfg, args.slice(1))
  }
  if (args.length && args.join() !== '--try') throw new Fail('usage: xtend temp [--try | --proof <commit> "<command>"]')
  if (!tryGit('rev-parse', '--verify', '-q', `upstream/${cfg.branch}`)) throw new Fail('upstream has not been fetched yet. Run `xtend sync` first.')
  if (args.length) {
    requireClean()
    const unready = prepare(cfg)
    if (unready) throw new Fail(unready)
    retireTemps(cfg, tempFixes(cfg))
    pushIfFork()
  }
  const fixes = tempFixes(cfg)
  if (!fixes.length) return console.log('no temporary fixes')
  for (const fix of fixes) {
    console.log(`${fix.sha.slice(0, 10)}  ${fix.subject}`)
    console.log(`            ${sameAsUpstream(cfg, fix.files) ? "upstream's code is in its place; the next sync or `xtend temp --try` retires it" : `still differs from upstream in: ${fix.files.join(', ')}`}`)
    console.log(`            ${fix.proof ? `proof: ${fix.proof}` : 'no proof, so it stays until its files match upstream'}`)
  }
}

// For an agent that made the change itself. It passes the same check and gets the same commit as a change xtend asked an agent for,
// with hooks off like every git xtend starts, so a repo's pre-commit tasks cannot stand in for or block the check.
function commitChange(cfg, args) {
  const cut = args.indexOf('--')
  const paths = cut >= 0 ? args.splice(cut).slice(1) : []
  const at = args.indexOf('-m')
  const why = at >= 0 ? args.splice(at, 2)[1] || '' : ''
  const proofAt = args.indexOf('--proof')
  const proof = proofAt >= 0 ? args.splice(proofAt, 2)[1] || '' : ''
  const isTemp = args.includes('--temp')
  args = args.filter((a) => a !== '--temp')
  const trailers = tempTrailers(isTemp, proof)
  const request = args.join(' ').trim()
  if (!request || (proofAt >= 0 && !proof)) throw new Fail('usage: xtend commit "<what the user asked for>" [-m "<what you changed and why>"] [--temp] [--proof "<command>"] [-- <path>...]')
  if (fs.existsSync(syncState())) throw new Fail('a sync is waiting to be finished. Run `xtend sync --continue`, or `xtend sync --abort` to drop it.')
  if (paths.length) git('add', '--', ...paths)
  else git('add', '-A')
  if (!git('diff', '--cached', '--name-only')) throw new Fail('nothing to commit')
  const unproven = proof && command(proof)
  const problem = unproven || check(cfg)
  if (problem) {
    console.log(problem)
    log(`not committed: the ${unproven ? 'proof has to pass with the fix in place' : 'check failed'}. Your edits are staged. Fix them and run it again.`)
    process.exitCode = 2
    return
  }
  git('commit', '-q', '-m', `xtend: ${request}`, '-m', withTrailers(why || request, trailers))
  log(trailers ? 'committed as a temporary fix' : 'committed')
  pushIfFork()
}

// --- seams, news and status -------------------------------------------

const seamList = (cfg) => (cfg.seams || []).map((s) => `- ${s.file}: \`${s.has}\`${s.why ? ` (${s.why})` : ''}`).join('\n') || '(none recorded)'

function seam(cfg, args) {
  const drop = args[0] === '--drop'
  if (drop) args = args.slice(1)
  const at = args.indexOf('-m')
  const why = at >= 0 ? args.splice(at, 2)[1] || '' : ''
  const [file, has] = args
  if (args.length !== 2 || !file || !has || (drop && why)) throw new Fail('usage: xtend seam <file> "<text>" [-m "<what it hooks in>"] | xtend seam --drop <file> "<text>"')
  const data = readJson(CONFIG)
  const others = (data.seams || []).filter((s) => !(s.file === file && s.has === has))
  if (drop && others.length === (data.seams || []).length) throw new Fail(`no seam is recorded for that text in ${file}. \`xtend seams\` lists them.`)
  // A seam recorded while it is not there would fail every check from the first one.
  if (!drop && !seamHeld({ file, has })) throw new Fail(`${file} does not have that text, so there is nothing to hold on to. Give the exact text, as it stands in the file.`)
  data.seams = drop ? others : [...others, { file, has, ...(why ? { why } : {}) }]
  if (!data.seams.length) delete data.seams
  fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2) + '\n')
  log(`${drop ? 'dropped' : 'recorded'} the seam in ${file}. It is in ${CONFIG}; \`xtend commit\` takes it along with your change.`)
}

function seams(cfg, args) {
  if (args.length) throw new Fail('usage: xtend seams')
  if (!(cfg.seams || []).length) return console.log('no seams recorded. Record one with: xtend seam <file> "<text>" -m "<what it hooks in>"')
  for (const s of cfg.seams) console.log(`${seamHeld(s) ? 'ok  ' : 'GONE'}  ${s.file}: ${s.has}${s.why ? `  (${s.why})` : ''}`)
  if (seamsGone(cfg).length) process.exitCode = 2
}

// The files of upstream's that this copy has changed: where a merge can collide, and where seams live. Worked out from this copy's own
// commits, since with two sources there is no single commit to diff against. A file counts while it differs from every source that has it.
function yourUpstreamFiles(cfg) {
  // A commit with no parent is where a shallow clone was cut, and would count every file in the repo as changed here.
  const touched = [...new Set(git('log', '--no-merges', '--min-parents=1', '--format=', '--name-only', ...ownRange(cfg), '--', ...MINE).split('\n').filter(Boolean))].filter((f) => fs.existsSync(f))
  if (!touched.length) return []
  // The whole diff, read here, since the files touched can be more than a command line holds.
  const views = sources(cfg).map((ref) => new Map(git('diff', '--name-status', '--no-renames', ref, 'HEAD', '--', ...MINE).split('\n').filter(Boolean).map((l) => l.split('\t').reverse())))
  return touched.filter((f) => views.some((v) => v.get(f) === 'M') && views.every((v) => v.has(f))).sort()
}

// What a sync is about to bring in, worked out before the merge: how much, which of it lands in files you changed, and which
// hosts its added lines name that nothing in this copy named before. The last is a prompt to look, not a verdict.
function incomingNews(cfg, theirs, touched) {
  const base = git('merge-base', 'HEAD', theirs)
  const yours = new Set(yourUpstreamFiles(cfg))
  let hosts = null
  const diff = run('git', ['diff', '-U0', '-G', 'https?://', `${base}..${theirs}`, '--', '.', ':!*lock*', ':!*.lock'])
  if (diff.ok) {
    const added = diff.out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n')
    const named = [...new Set([...added.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))]
    hosts = named.filter((h) => !/(^|\.)example\.(com|org|net)$|^localhost$/.test(h)).slice(0, 200).filter((h) => !run('git', ['grep', '-qiF', h, 'HEAD']).ok).sort()
  }
  return {
    at: new Date().toISOString().slice(0, 10),
    to: git('rev-parse', '--short', theirs),
    commits: Number(git('rev-list', '--count', '--no-merges', `HEAD..${theirs}`)),
    files: touched.length,
    yours: touched.filter((f) => yours.has(f)),
    hosts,
  }
}

// "renamed" in the config maps a name of upstream's to what this copy calls the same thing: { "Acme Code": "My Code" }. Upstream goes on
// writing its own name in new lines, and a merge takes them without a conflict, so nothing fails and the old name turns up in the product.
// These are the lines added since `base` that say it. Which of them a person or a model reads is for whoever finishes the sync to judge.
function renamedPairs(cfg) {
  const pairs = Object.entries(cfg.renamed || {})
  if (pairs.some(([from, to]) => !from || typeof to !== 'string')) throw new Fail(`${CONFIG}: "renamed" maps a name of upstream's to this copy's name for it, like { "Acme Code": "My Code" }`)
  return pairs
}

function oldNames(cfg, base, cached = false) {
  const pairs = renamedPairs(cfg)
  if (!pairs.length) return []
  const anyName = pairs.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const diff = run('git', ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '-G', anyName, ...(cached ? ['--cached'] : []), base, '--', ...MINE])
  if (!diff.ok) return []
  const found = []
  let file = null
  let line = 0
  let left = [0, 0]
  for (const l of diff.out.split('\n')) {
    // Inside a hunk the counts from its header say how many lines are still its own, so a line of content that looks like a header is not read as one.
    if (left[0] + left[1] > 0) {
      if (l.startsWith('-')) left[0]--
      else if (l.startsWith('+')) {
        left[1]--
        for (const [from, to] of pairs) if (l.includes(from)) found.push({ name: from, to, file, line, text: l.slice(1).trim() })
        line++
      }
      continue
    }
    const hunk = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) { left = [Number(hunk[1] ?? 1), Number(hunk[3] ?? 1)]; line = Number(hunk[2]) }
    else if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6)
  }
  return found
}

// For the news: per name, how many lines and which files.
function nameCounts(found) {
  const by = new Map()
  for (const f of found) {
    const row = by.get(f.name) || { name: f.name, to: f.to, lines: 0, files: [] }
    row.lines++
    if (!row.files.includes(f.file)) row.files.push(f.file)
    by.set(f.name, row)
  }
  return [...by.values()]
}
const nameLines = (names = []) => names.map((n) => `${plural(n.lines, 'new line')} still ${n.lines === 1 ? 'says' : 'say'} "${n.name}", which this copy calls "${n.to}", in ${plural(n.files.length, 'file')}: ${some(n.files)}. Rename the ones a person or a model reads; \`xtend names\` lists them`)

// The commit this copy stood at before its last sync, or stands at now while one is open.
function beforeSync() {
  if (fs.existsSync(syncState())) return git('rev-parse', 'HEAD')
  const merge = git('log', '--merges', '--first-parent', '-1', '--format=%H', '--grep=^xtend: sync ')
  return merge ? git('rev-parse', `${merge}^1`) : null
}

function names(cfg, args) {
  if (args.length && args.join() !== '--json') throw new Fail('usage: xtend names [--json]')
  const pairs = renamedPairs(cfg)
  if (!pairs.length) return console.log(`no names recorded. If this copy calls something by another name than upstream does, say so in ${CONFIG}: "renamed": { "<upstream's name>": "<yours>" }`)
  const base = beforeSync()
  if (!base) return console.log('no sync yet, so no new lines to look through')
  const found = oldNames(cfg, base)
  if (args.length) return console.log(JSON.stringify(found, null, 2))
  if (!found.length) return console.log(`no line that came in with the last sync says ${pairs.map(([from]) => `"${from}"`).join(' or ')}`)
  for (const f of found) console.log(`${f.file}:${f.line}: ${f.text}`)
  log(`${plural(found.length, 'line')} new since before the last sync. Comments and the like can stay; what a person or a model reads wants this copy's name.`)
}

const lastSync = () => git('rev-parse', '--git-path', 'xtend-last-sync.json')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : /(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`

function newsLines(news) {
  return [
    `brought in ${plural(news.commits, 'upstream commit')} (${news.to}) changing ${plural(news.files, 'file')}`,
    news.yours.length ? `${news.yours.length} of those are files you changed, so look at them: ${news.yours.join(', ')}` : 'none of those are files you changed',
    news.hosts === null ? null : news.hosts.length ? `hosts named in what came in that this copy had not named before: ${news.hosts.join(', ')}` : 'no host is named in what came in that this copy had not named before',
    ...nameLines(news.names),
  ].filter(Boolean)
}

function reportNews(news) {
  fs.writeFileSync(lastSync(), JSON.stringify(news))
  for (const line of newsLines(news)) log(line)
}

// One call for an agent arriving cold: everything it would otherwise piece together from a dozen git commands.
function status(cfg, args) {
  const json = args.includes('--json')
  const fetch = !args.includes('--no-fetch')
  if (args.some((a) => a !== '--json' && a !== '--no-fetch')) throw new Fail('usage: xtend status [--json] [--no-fetch]')
  if (!tryGit('remote', 'get-url', 'upstream')) git('remote', 'add', 'upstream', cfg.upstream)
  const theirs = `upstream/${cfg.branch}`
  const notes = []
  if (fetch && !run('git', ['fetch', '-q', 'upstream', cfg.branch]).ok) notes.push('could not reach upstream, so this is as of the last fetch')
  if (!tryGit('rev-parse', '--verify', '-q', theirs)) throw new Fail('upstream has not been fetched yet. Run `xtend sync` first.')
  const count = (range) => Number(git('rev-list', '--count', range))
  // root is where upstream itself comes from, when upstream is someone else's fork. A fork can fall behind its source without a word.
  let root = null
  if (cfg.root) {
    if (fetch && !fetchRoot(cfg)) notes.push(`could not reach ${cfg.root}, so its numbers are as of the last fetch`)
    if (hasRef(ROOT_REF)) root = { repo: cfg.root, upstreamBehind: count(`${theirs}..${ROOT_REF}`), behind: count(`HEAD..${ROOT_REF}`), newest: git('log', '-1', '--format=%cs', ROOT_REF), synced: !!cfg.syncRoot }
  }
  const origin = fetch ? originAhead() : null
  if (cutShort(cfg)) notes.push(`this clone is shallow and stops short of where this copy left upstream, so "of its own" and "yours" count only what is here. ${DEEPEN}`)
  const fixes = tempFixes(cfg)
  const generated = generatedRules(cfg).map((r) => r.test)
  const out = {
    upstream: cfg.upstream,
    branch: cfg.branch,
    behind: count(`HEAD..${theirs}`),
    ahead: Number(git('rev-list', '--count', ...ownRange(cfg))),
    root,
    origin,
    syncOpen: fs.existsSync(syncState()),
    uncommitted: git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).length,
    yourUpstreamFiles: yourUpstreamFiles(cfg).map((file) => ({
      file,
      seams: (cfg.seams || []).filter((s) => s.file === file).length,
      temporary: fixes.some((f) => f.files.includes(file)),
      generated: generated.some((g) => g.test(file)),
    })),
    seams: (cfg.seams || []).map((s) => ({ ...s, held: seamHeld(s) })),
    temporaryFixes: fixes.map((f) => ({ commit: f.sha.slice(0, 10), what: f.subject, proof: f.proof || null, files: f.files })),
    commands: { prepare: cfg.prepare || null, check: cfg.check || null, verify: cfg.verify || null },
    lastSync: fs.existsSync(lastSync()) ? readJson(lastSync()) : null,
    notes,
  }
  if (json) return console.log(JSON.stringify(out, null, 2))
  const row = (name, text) => console.log(`${name.padEnd(10)}${text}`)
  row('upstream', `${out.upstream} (${out.branch}): this copy is ${out.behind} behind, with ${plural(out.ahead, 'commit')} of its own${out.behind ? '. `xtend sync` brings it in' : ''}`)
  if (root) row('root', `${root.repo}: upstream is ${root.upstreamBehind} behind it and this copy ${root.behind} (its newest commit is from ${root.newest})${root.behind ? `. ${root.synced ? '`xtend sync` brings it in too' : '`xtend sync --root` merges it directly'}` : ''}`)
  if (origin) row('origin', originNote(origin))
  if (out.syncOpen) row('sync', 'one is open. Finish it with `xtend sync --continue`, or drop it with `xtend sync --abort`')
  if (out.uncommitted) row('tree', `${plural(out.uncommitted, 'uncommitted file')}`)
  // A changed file of upstream's with neither a seam nor a temporary fix is one a merge can quietly undo: the list to record seams from.
  const bare = out.yourUpstreamFiles.filter((f) => !f.seams && !f.temporary && !f.generated)
  const sorts = [[out.yourUpstreamFiles.filter((f) => f.seams).length, 'with a seam'], [out.yourUpstreamFiles.filter((f) => f.temporary).length, 'in a temporary fix'], [out.yourUpstreamFiles.filter((f) => f.generated && !f.seams && !f.temporary).length, 'generated'], [bare.length, 'with neither']]
  row('yours', out.yourUpstreamFiles.length ? `${plural(out.yourUpstreamFiles.length, 'file')} of upstream's changed: ${sorts.filter(([n]) => n).map(([n, what]) => `${n} ${what}`).join(', ')}${bare.length ? `. Neither:\n${bare.map((f) => `          - ${f.file}`).join('\n')}` : ''}` : "none of upstream's files changed")
  const gone = out.seams.filter((s) => !s.held)
  row('seams', !out.seams.length ? 'none recorded' : gone.length ? `${gone.length} of ${out.seams.length} GONE:\n${gone.map((s) => `          - ${seamLine(s)}`).join('\n')}` : `${out.seams.length} held`)
  row('temporary', fixes.length ? `${plural(fixes.length, 'fix')} carried: ${fixes.map((f) => f.subject).join('; ')}` : 'no fixes carried')
  row('commands', Object.entries(out.commands).map(([k, v]) => `${k}: ${v || 'none'}`).join(' | '))
  row('last sync', out.lastSync ? `${out.lastSync.at}: ${newsLines(out.lastSync).join('; ')}` : 'none recorded on this device')
  for (const note of notes) row('note', note)
  if (gone.length || out.syncOpen) process.exitCode = 2
}

// --- sync --------------------------------------------------------------

function sync(cfg, args = []) {
  const usage = 'usage: xtend sync [--root] [--prompt] | --continue [-m "<what you decided>"] [--temp "<what you fixed>" [--proof "<command>"]] | --abort'
  const onlyRoot = args.includes('--root')
  const [flag = '', ...more] = args.filter((a) => a !== '--root')
  if (flag && !['--prompt', '--continue', '--abort'].includes(flag)) throw new Fail(usage)
  const at = more.indexOf('-m')
  const body = at >= 0 ? more.splice(at, 2)[1] || '' : ''
  if (at >= 0 && (flag !== '--continue' || !body)) throw new Fail(usage)
  if (more.length && (flag !== '--continue' || more[0] !== '--temp')) throw new Fail(usage)
  if (onlyRoot && (flag === '--continue' || flag === '--abort')) throw new Fail(usage)
  if (flag === '--continue' || flag === '--abort') return resumeSync(cfg, flag, more.length ? more.slice(1) : null, body)
  requireClean()
  if (onlyRoot && !cfg.root) throw new Fail(`this copy has no root. Set "root": "owner/repo" in ${CONFIG}: the repo your upstream was itself forked from.`)
  if (!tryGit('remote', 'get-url', 'upstream')) git('remote', 'add', 'upstream', cfg.upstream)
  const upstream = `upstream/${cfg.branch}`
  if (!onlyRoot || !hasRef(upstream)) git('fetch', '-q', 'upstream', cfg.branch)
  // Upstream first, then the root where the config asks for both. One merge at a time: a merge left open ends the run, and the next run goes on.
  const from = onlyRoot ? [] : [{ theirs: upstream, label: upstream, what: 'upstream' }]
  if (onlyRoot || (cfg.syncRoot && cfg.root)) {
    if (fetchRoot(cfg)) from.push({ theirs: ROOT_REF, label: `root ${cfg.root}`, what: `the root, ${cfg.root},` })
    else if (onlyRoot) throw new Fail(`could not fetch ${cfg.rootBranch || cfg.branch} from ${cfg.root}`)
    else log(`could not reach ${cfg.root}, so only upstream is synced this time`)
  }
  const stale = originAhead()
  if (stale) log(originNote(stale))
  if (from.some((source) => !tryGit('merge-base', 'HEAD', source.theirs)) && cutShort(cfg)) throw new Fail(`this clone is shallow and stops short of where this copy left upstream, so there is nothing to merge from. ${DEEPEN}`)
  let merged = 0
  for (const source of from) {
    if (tryGit('merge-base', '--is-ancestor', source.theirs, 'HEAD')) continue
    if (!syncFrom(cfg, flag, source)) return
    merged++
  }
  if (merged) return
  log('already up to date')
  pushIfFork()
}

// With no agent to ask, a sync that needs one changes nothing and says so where someone will see it: an issue, when it runs as an Action.
function needsHand(label, problem) {
  const text = `xtend could not finish syncing ${label} by itself, and changed nothing.\n\n${problem}\n\nAn agent working in the repo can finish it: run \`xtend sync --prompt\`, do what it prints, then \`xtend sync --continue\`.`
  log(text)
  process.exitCode = 3
  if (!process.env.GITHUB_ACTIONS || !hasGh()) return
  const title = 'xtend: the daily sync needs a hand'
  const listed = gh(['issue', 'list', '--state', 'open', '--search', `in:title "${title}"`, '--json', 'number'])
  let open
  try { open = JSON.parse(listed.out)[0]?.number } catch {}
  const r = open ? gh(['issue', 'comment', String(open), '--body', text]) : gh(['issue', 'create', '--title', title, '--body', text])
  if (!r.ok) log(`could not open an issue about it: ${r.err}`)
}

// Merges one source. True when it is merged and pushed; false when it is left for someone (an open merge, or nothing changed and a report).
function syncFrom(cfg, flag, { theirs, label, what }) {
  const before = git('rev-parse', 'HEAD')
  const temps = tempFixes(cfg)
  const touched = git('diff', '--name-only', `HEAD...${theirs}`).split('\n').filter(Boolean)
  const news = incomingNews(cfg, theirs, touched)
  const incoming = git('log', '--no-merges', '--format=- %s', `HEAD..${theirs}`)
  const ours = git('log', '--no-merges', '--format=- %B', ...ownRange(cfg))
  run('git', ['merge', '--no-ff', '--no-commit', theirs])
  const done = settle(cfg)
  const byRule = settledLines(done)
  const conflicted = git('diff', '--name-only', '--diff-filter=U')
  const replayedNow = replay(conflicted)
  const { reused, wrong } = replayedNow
  let { open } = replayedNow
  let yielded = []
  let agentRan = false
  let bad = []

  const verify = () => {
    if (!fs.existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) return 'the merge was committed or aborted; leave that to xtend'
    git('add', '-A')
    return markersLeft(conflicted) || checkMerge(cfg, done.runs)
  }

  // A conflict in a file that only proven temporary fixes changed is upstream reaching the same code. Take upstream's side, and keep it
  // if every proof and the check pass; otherwise put the conflict back for the agent.
  const stopgapOnly = (f) => {
    const by = git('log', '--no-merges', '--format=%H', ...ownRange(cfg, before), '--', f).split('\n').filter((sha) => sha && !temps.settled.has(sha))
    return by.length > 0 && by.every((sha) => temps.find((t) => t.sha === sha)?.proof)
  }
  const yieldStopgaps = () => {
    const files = open.split('\n').filter(stopgapOnly)
    if (!files.length || !run('git', ['checkout', '--theirs', '--', ...files]).ok) return
    git('add', '--', ...files)
    const rest = open.split('\n').filter((f) => !files.includes(f)).join('\n')
    const proofs = [...new Set(temps.filter((t) => t.proof && t.files.some((f) => files.includes(f))).map((t) => t.proof))]
    const trouble = prepare(cfg) || proofs.map((cmd) => command(cmd)).find(Boolean) || (rest ? null : verify())
    if (trouble) return git('checkout', '-m', '--', ...files)
    open = rest
    yielded = files
  }

  let problem
  try {
    if (open) yieldStopgaps()
    problem = open ? `conflicts in:\n${open}` : verify()
    if (problem && reused.length) problem = `${replayed(reused)}\n\n${problem}`
    if (problem && byRule.length) problem = `xtend has already settled these by rule, so leave them as they are unless the failure below is in them:\n${byRule.map((l) => `- ${l}`).join('\n')}\n\n${problem}`
    const oldNamed = problem ? nameLines(nameCounts(oldNames(cfg, 'HEAD'))) : []
    if (oldNamed.length) problem += `\n\nAlso, in what is coming in:\n${oldNamed.map((l) => `- ${l.replace(' still ', ' ')}`).join('\n')}`
    // For an agent that is already working in this repo: leave the merge open and hand it the same prompt the sync step would get.
    if (problem && flag === '--prompt') {
      // With no conflicts the index is exactly what the merge produced, so a fix made from here on can be told apart from the merge.
      const tree = conflicted ? null : git('write-tree')
      fs.writeFileSync(syncState(), JSON.stringify({ theirs, label, conflicted, touched, tree, news, byRule, runs: done.runs, reused: Object.fromEntries(reused.map((f) => [f, fileHash(f)])) }))
      console.log(promptFor(cfg, 'sync', { sheet: sheet(), ours: ours || '(none recorded)', incoming, problem, seams: seamList(cfg) }))
      log('the merge is open. Do what the prompt says, then run `xtend sync --continue`. `xtend sync --abort` puts everything back.')
      if (tree) log('If upstream itself is broken, fix it and finish with `xtend sync --continue --temp "<what you fixed>" --proof "<command>"`. Your fix is then a temporary one, dropped when upstream no longer needs it.')
      process.exitCode = 2
      return false
    }
    if (problem && cfg.steps.sync.agent.value === NO_AGENT) {
      git('reset', '-q', '--hard', before)
      git('clean', '-qfd')
      needsHand(label, problem)
      return false
    }
    if (problem) {
      agentRan = true
      problem = resolveMerge(cfg, { ours, incoming, problem }, verify)
    }
    if (!problem) {
      bad = wrong()
      news.names = nameCounts(oldNames(cfg, 'HEAD', true))
      const c = run('git', ['commit', '-q', '-m', `xtend: sync ${label} (${git('rev-parse', '--short', theirs)})`])
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
  const fixed = conflicted.split('\n').filter((f) => f && !kept.includes(f) && !yielded.includes(f))
  log([
    conflicted || agentRan ? `merged ${what}` : `merged ${what} cleanly`,
    kept.length && `reused ${kept.length} resolution${kept.length === 1 ? '' : 's'} git remembered: ${kept.join(', ')}`,
    yielded.length && `took upstream's code where only a temporary fix had been: ${yielded.join(', ')}`,
    fixed.length && `agent resolved: ${fixed.join(', ')}`,
    agentRan && !fixed.length && 'agent fixed what the check reported',
    bad.length && 'git forgot its old resolutions, because the agent had to change them',
  ].filter(Boolean).join('; '))
  for (const line of byRule) log(line)
  retireTemps(cfg, tempFixes(cfg).filter((t) => t.files.some((f) => touched.includes(f))))
  reportNews(news)
  pushIfFork()
  return true
}

function resumeSync(cfg, flag, asTemp = null, body = '') {
  const stopgap = asTemp || []
  const file = syncState()
  if (!fs.existsSync(file)) throw new Fail('no sync is waiting. Start one with `xtend sync --prompt`.')
  const { theirs, conflicted, reused, touched = [], tree = null, news = null, label = theirs, byRule = [], runs = [] } = readJson(file)
  const proofAt = stopgap.indexOf('--proof')
  const proof = proofAt >= 0 ? stopgap.splice(proofAt, 2)[1] || '' : ''
  const request = stopgap.join(' ').trim()
  if (asTemp && (!request || (proofAt >= 0 && !proof))) throw new Fail('usage: xtend sync --continue --temp "<what you fixed>" [--proof "<command>"]')
  if (request && !tree) throw new Fail('--temp needs a merge that had no conflicts, or xtend cannot tell your fix from the merge. Finish with `xtend sync --continue`.')
  if (flag === '--abort') {
    git('reset', '-q', '--hard', 'HEAD')
    git('clean', '-qfd')
    fs.rmSync(file)
    return log('sync dropped, nothing changed')
  }
  if (!fs.existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) {
    fs.rmSync(file)
    throw new Fail('the merge was committed or aborted outside xtend, so there is nothing to continue. Run `xtend sync` again.')
  }
  git('add', '-A')
  const problem = markersLeft(conflicted) || (proof && (prepare(cfg) || command(proof))) || checkMerge(cfg, runs)
  if (problem) {
    console.log(problem)
    log('not finished. Fix that, then run `xtend sync --continue` again, or `xtend sync --abort`.')
    process.exitCode = 2
    return
  }
  const bad = Object.keys(reused).filter((f) => fileHash(f) !== reused[f])
  if (bad.length) fs.rmSync(git('rev-parse', '--git-path', 'rr-cache'), { recursive: true, force: true })
  else run('git', ['rerere'])
  const names = nameCounts(oldNames(cfg, 'HEAD', true))
  // What was merged, not where `theirs` points by now: a fetch while the sync was open may have moved it on.
  const subject = `xtend: sync ${label} (${git('rev-parse', '--short', 'MERGE_HEAD')})`
  if (request) {
    // The merge is committed as git made it, and what was changed since becomes its own commit, marked temporary.
    if (git('write-tree') === tree) throw new Fail('nothing changed since the merge, so there is no fix to record. Run `xtend sync --continue` without --temp.')
    const merge = git('commit-tree', tree, '-p', 'HEAD', '-p', 'MERGE_HEAD', '-m', subject, ...(body ? ['-m', body] : []))
    git('update-ref', 'HEAD', merge)
    run('git', ['merge', '--quit'])
    git('commit', '-q', '-m', `xtend: ${request}`, '-m', tempTrailers(true, proof))
    log(`recorded "${request}" as a temporary fix`)
  } else {
    const c = run('git', ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])])
    if (!c.ok) throw new Fail(`git commit failed:\n${c.err || c.out}`)
  }
  fs.rmSync(file)
  const kept = Object.keys(reused).filter((f) => !bad.includes(f))
  const fixed = conflicted.split('\n').filter((f) => f && !kept.includes(f))
  for (const line of byRule) log(line)
  log([`merged ${label === theirs ? 'upstream' : label}`, kept.length && `reused ${kept.length} resolution${kept.length === 1 ? '' : 's'} git remembered: ${kept.join(', ')}`, fixed.length && `resolved by hand: ${fixed.join(', ')}`].filter(Boolean).join('; '))
  retireTemps(cfg, tempFixes(cfg).filter((t) => t.files.some((f) => touched.includes(f))))
  if (news) reportNews({ ...news, names })
  const moved = originAhead()
  if (moved) log(originNote(moved))
  if (fs.existsSync(beforeState())) log(`the copy from before this sync is still at ${readJson(beforeState()).dir}. Remove it with \`xtend before --done\`.`)
  pushIfFork()
}

function resolveMerge(cfg, { ours, incoming, problem }, verify) {
  const vars = { sheet: sheet(), ours: ours || '(none recorded)', incoming, problem, seams: seamList(cfg) }
  return agentUntil(cfg, 'sync', vars, verify).problem
}

// --- before ------------------------------------------------------------

// A failure after a sync is either the merge's doing or was there already, and only the same command run on this copy as it was before
// tells which. `before` keeps one more checkout of that commit beside this one, prepares it once, and runs the command there.
const beforeState = () => git('rev-parse', '--git-path', 'xtend-before.json')

function dropBefore() {
  const file = beforeState()
  if (!fs.existsSync(file)) return false
  const { dir } = readJson(file)
  run('git', ['worktree', 'remove', '--force', dir])
  run('git', ['worktree', 'prune'])
  fs.rmSync(file)
  return true
}

function before(cfg, args) {
  const usage = 'usage: xtend before [--at <commit>] "<command>" | xtend before --done'
  if (args.join() === '--done') return log(dropBefore() ? 'removed the copy from before the sync' : 'there is no copy from before a sync to remove')
  const at = args.indexOf('--at')
  const asked = at >= 0 ? args.splice(at, 2)[1] || '' : ''
  const cmd = args.join(' ').trim()
  if (!cmd || cmd.startsWith('--') || (at >= 0 && !asked)) throw new Fail(usage)
  const want = asked || beforeSync()
  if (!want) throw new Fail('there is no sync to look behind yet. Name a commit: xtend before --at <commit> "<command>"')
  const sha = run('git', ['rev-parse', '--verify', '-q', `${want}^{commit}`]).out
  if (!sha) throw new Fail(`${want} is not a commit here`)
  const file = beforeState()
  let state = fs.existsSync(file) ? readJson(file) : null
  if (state && (state.sha !== sha || !fs.existsSync(state.dir))) { dropBefore(); state = null }
  if (!state) {
    const dir = path.resolve('..', `${path.basename(process.cwd())}-before`)
    if (fs.existsSync(dir)) throw new Fail(`${dir} is in the way. Move it, then run this again.`)
    git('worktree', 'add', '-q', '--detach', dir, sha)
    state = { dir, sha }
    fs.writeFileSync(file, JSON.stringify(state))
    log(`checked out ${sha.slice(0, 10)} in ${dir}${cfg.prepare ? `, preparing it with: ${cfg.prepare}` : ''}`)
    const unready = cfg.prepare ? command(cfg.prepare, dir) : null
    if (unready) {
      dropBefore()
      throw new Fail(`could not prepare the copy from before, so it was removed:\n${unready}`)
    }
  }
  const r = spawnSync(cmd, { shell: true, cwd: state.dir, env: { ...process.env, PWD: state.dir }, stdio: 'inherit' })
  log(`that ran on this copy as it was at ${sha.slice(0, 10)}, in ${state.dir}, and ${r.status === 0 ? 'passed' : `failed (exit ${r.status ?? r.signal})`}. A failure you see there as well is not this sync's doing. \`xtend before --done\` removes the copy.`)
  process.exitCode = r.status ?? 1
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
  return git('rev-list', '--reverse', '--no-merges', 'HEAD', '--not', theirs, ...(hasRef(ROOT_REF) ? [ROOT_REF] : [])).split('\n').filter(Boolean).map((sha) => ({
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
        git('add', '-A', '--', ...MINE)
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
    `Changes from a fork of this project, offered back in case you want any of them. Each one is a single commit on top of your \`${cfg.branch}\`. ${via === 'pr' ? 'Merge them all, or take' : 'Take'} any one with the commands under it.`,
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

// `setup` is the repo's own steps for the Action, from "daily": { "setup": [...] } in the config: what its prepare, check and verify need
// that a bare runner lacks. A string is a command; an object is a step as GitHub writes it, such as { "uses": "actions/setup-node@v4" }.
function workflow(agent, agents, setup = []) {
  const [, p] = presetOf(agent, agents)
  const steps = setup.map((step) => `      - ${typeof step === 'string' ? `run: ${JSON.stringify(step)}` : JSON.stringify(step)}\n`).join('')
  return `name: xtend sync
on:
  schedule: [{ cron: '17 6 * * *' }]
  workflow_dispatch:
permissions:
  contents: write
  issues: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
${steps}${p.install ? `      - run: npm i -g ${p.install}\n` : ''}      - run: |
          git config user.name "xtend"
          git config user.email "xtend@users.noreply.github.com"
          node .xtend/xtend.mjs sync
        env:
          GH_TOKEN: \${{ github.token }}
${p.key ? `          ${p.key}: \${{ secrets.${p.key} }}\n` : ''}`
}

function actionNote(agent, repo, agents) {
  if (agent === NO_AGENT) return 'With no agent it lands the syncs that merge and pass by themselves, and opens an issue when one needs someone.'
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
    fs.writeFileSync(WORKFLOW_FILE, workflow(actionAgent(cfg.repo), cfg.repo.agents, cfg.repo.daily?.setup))
    git('add', WORKFLOW_FILE)
  } else if (on) git('rm', '-q', WORKFLOW_FILE)
  if (run('git', ['diff', '--cached', '--quiet']).ok) log(`daily sync is already ${want}`)
  else git('commit', '-q', '-m', `xtend: daily sync ${want}`)
  pushIfFork()
  const repo = origin && githubSlug(origin)
  if (want === 'on' && repo && hasGh() && !gh(['api', '-X', 'PUT', `repos/${repo}/actions/permissions`, '-F', 'enabled=true']).ok) log(`could not turn on Actions; turn them on at https://github.com/${repo}/actions`)
  if (want === 'on') quietWorkflows()
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (want === 'on' && cfg.branch && branch !== cfg.branch) log(`GitHub runs scheduled Actions only from the default branch, and this is ${branch}. Merge it into ${cfg.branch}.`)
  log(want === 'on' ? `daily sync is on. ${repo ? actionNote(actionAgent(cfg.repo), repo, cfg.repo.agents) : 'It runs once origin is on GitHub.'}` : 'daily sync is off')
}

// The repo carries the xtend that set it up. Run a newer xtend here to hand the repo, and its daily Action, that version.
function update() {
  const mine = fileURLToPath(import.meta.url)
  const theirs = `${DIR}/xtend.mjs`
  if (fileHash(mine) === fileHash(theirs)) return log(`${theirs} is already this xtend`)
  requireClean()
  fs.copyFileSync(mine, theirs)
  git('add', theirs)
  git('commit', '-q', '-m', 'xtend: update xtend')
  log(`updated ${theirs}`)
  pushIfFork()
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
  if (fs.existsSync(WORKFLOW_FILE)) fs.writeFileSync(WORKFLOW_FILE, workflow(actionAgent(cfg.repo, agent), cfg.repo.agents, cfg.repo.daily?.setup))
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
  else if (verb === 'commit') commitChange(loadConfig(), rest)
  else if (verb === 'fix') fix(loadConfig(), rest)
  else if (verb === 'temp') temp(loadConfig(), rest)
  else if (verb === 'sync') sync(loadConfig(), rest)
  else if (verb === 'status') status(loadConfig(), rest)
  else if (verb === 'seam') seam(loadConfig(), rest)
  else if (verb === 'seams') seams(loadConfig(), rest)
  else if (verb === 'names') names(loadConfig(), rest)
  else if (verb === 'before') before(loadConfig(), rest)
  else if (verb === 'share') share(loadConfig(), rest)
  else if (verb === 'sheet') writeSheet(loadConfig(false), rest)
  else if (verb === 'update' && !rest.length) (loadConfig(), update())
  else if (verb === 'config') config(rest)
  else change(loadConfig(), [verb, ...rest].join(' '))
} catch (e) {
  if (!(e instanceof Fail)) throw e
  console.error(`xtend: ${e.message}`)
  process.exitCode = 1
}
