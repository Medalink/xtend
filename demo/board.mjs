// Builds docs/index.html from the real runs in docs/data/apps. One toggle switches every section between the apps.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(here, '..', 'docs')
const REPO = 'https://github.com/Medalink/xtend'
const TWEET = 'https://x.com/trq212/status/2115188992861970693'
const ORDER = ['pomo', 'rust', 'php', 'python']
const APPS_DIR = path.join(DOCS, 'data', 'apps')
const apps = fs.readdirSync(APPS_DIR).map((f) => JSON.parse(fs.readFileSync(path.join(APPS_DIR, f), 'utf8')))
  .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
const first = apps[0].id

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const minutes = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`)
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const step = (a, title) => a.steps.find((s) => s.title === title)
const tail = (s, n) => s.split('\n').slice(-n).join('\n')
const TINT = [[/^xtend: (merged|committed|opened|branch|upstream takes|updated)|^OK$|passed|^ok\b|test result: ok/i, 'ok'], [/CONFLICT|FAILED|^error|Error:|SyntaxError|Automatic merge failed/i, 'bad'], [/^xtend:/, 'x']]
const tint = (out) => out.split('\n').map((l) => { const t = TINT.find(([re]) => re.test(l)); return t ? `<span class="x-t-${t[1]}">${esc(l)}</span>` : esc(l) }).join('\n')
const term = (command, output, label = command) =>
  `<pre class="x-term" tabindex="0" aria-label="${esc(label)}"><span class="sd-faint">$</span> ${esc(command)}\n${tint(output)}</pre>`
const each = (fn) => apps.map((a) => `<div class="x-app" data-app="${a.id}">${fn(a)}</div>`).join('')
const pick = `<div class="sd-seg sd-seg-inline sd-seg-sm x-pick" role="group" aria-label="Example app">${apps.map((a) =>
  `<button type="button" data-pick="${a.id}" aria-pressed="${a.id === first}">${esc(a.lang)}</button>`).join('')}</div>`
const head = (n, kicker, title, sub) => `
      <div class="x-head">
        <div>
          <p class="sd-label x-kicker"><b>${n}</b> ${kicker}</p>
          <h2 id="${kicker.toLowerCase().replace(/\W+/g, '-')}-h" class="x-h2">${title} <em>${sub}</em></h2>
        </div>
        ${pick}
      </div>`

// Every file either side touched, as two bars and what git made of it.
function fileMap(a) {
  const byFile = new Map()
  for (const side of ['yours', 'theirs']) for (const f of a.files[side]) byFile.set(f.file, { ...byFile.get(f.file), [side]: f })
  const max = Math.max(...[...byFile.values()].flatMap((v) => [v.yours, v.theirs].filter(Boolean).map((f) => f.add + f.del)))
  const bar = (f, kind) => f
    ? `<span class="x-bar" data-kind="${kind}"><i style="width:${Math.max(3, Math.round(((f.add + f.del) / max) * 100))}%"></i></span><span class="x-bar-n sd-subtle">${f.status === 'D' ? 'deleted' : f.status === 'A' ? `new +${f.add}` : `+${f.add} −${f.del}`}</span>`
    : '<span class="x-bar"></span><span class="x-bar-n sd-faint">untouched</span>'
  const rows = [...byFile.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([file, v]) => {
    const conflict = a.files.conflicted.includes(file)
    const verdict = conflict ? ['danger', 'conflict'] : v.yours && v.theirs ? ['pending', 'auto-merged'] : ['', v.yours ? 'yours only' : 'upstream only']
    return `<li class="x-file"><code>${esc(file)}</code>${bar(v.yours, 'yours')}${bar(v.theirs, 'theirs')}<span class="sd-status"${verdict[0] ? ` data-tone="${verdict[0]}"` : ''}>${verdict[1]}</span></li>`
  }).join('')
  return `<ul class="x-files" aria-label="Files changed">
          <li class="x-file x-file-head sd-label"><span>File</span><span>Yours</span><span></span><span>Upstream 2.0</span><span></span><span>git merge</span></li>${rows}</ul>`
}

// Upstream on top, the fork below, the merge where they meet.
const graph = (a) => `<svg class="x-graph" viewBox="0 0 640 132" role="img" aria-label="Upstream goes from 1.0 to 2.0. Your fork adds your change, then xtend sync merges 2.0 into it.">
          <line x1="40" y1="34" x2="600" y2="34" class="x-g-up"/>
          <path d="M40 34 L120 98 L600 98" class="x-g-you"/>
          <path d="M360 34 L440 98" class="x-g-merge"/>
          <rect x="34" y="28" width="12" height="12" class="x-g-node"/><text x="40" y="18">${esc(a.name)} 1.0</text>
          <rect x="354" y="28" width="12" height="12" class="x-g-node"/><text x="360" y="18">2.0</text>
          <rect x="174" y="92" width="12" height="12" class="x-g-node x-g-mine"/><text x="180" y="124">your change</text>
          <rect x="432" y="90" width="16" height="16" class="x-g-node x-g-done"/><text x="440" y="124">xtend sync</text>
          <rect x="534" y="92" width="12" height="12" class="x-g-node x-g-mine"/><text x="540" y="124">fix</text>
        </svg>`

const kept = (a) => ['yours', 'upstream'].map((side) => `
          <div class="x-cell">
            <p class="sd-label">${side === 'yours' ? 'Yours, kept' : 'Upstream 2.0, kept'}</p>
            <ul class="sd-checks">${Object.entries(a.kept[side]).map(([k, ok]) => `<li data-tone="${ok ? 'success' : 'danger'}">${esc(k)}</li>`).join('')}</ul>
          </div>`).join('')

const STATES = [['upstream1', '1.0'], ['yours', 'Yours'], ['upstream2', '2.0'], ['synced', 'Yours + 2.0']]
const screen = (a, state, label) => a.web
  ? `<a class="x-shot" href="${a.screens[state].href}"><span class="x-shot-head"><span class="sd-label">${label}</span><span class="sd-subtle">open</span></span><img src="img/${a.id}-${state}.png" alt="${esc(`${a.name}, ${label}`)}" width="1200" height="800" loading="lazy"></a>`
  : `<div class="x-shot"><span class="x-shot-head"><span class="sd-label">${label}</span><span class="sd-subtle">${esc(a.lang)}</span></span>${term(a.screens[state].command, a.screens[state].output, `${a.name}, ${label}`)}</div>`

// Shortens a long command, closing a quote it cut open.
const cut = (cmd) => { const s = cmd.slice(0, 57); return `${s}...${(s.match(/"/g) || []).length % 2 ? '"' : ''}` }

const FEATURES = [
  ['Merges by intent', 'Every change is a commit that says what you asked for. The agent rebuilds that on upstream\'s new code.'],
  ['Your check decides', 'Nothing lands until your tests, and the tests upstream just shipped, pass.'],
  ['All or nothing', 'Three tries, then it puts everything back and exits non-zero.'],
  ['Remembers resolutions', 'git rerere replays every conflict it has solved before. The agent only sees new ones.'],
  ['Daily sync, if you want', '`xtend daily on` adds a GitHub Action that syncs every day. A failure emails you.'],
  ['Any agent', 'Claude Code, Codex, Gemini, Amp, opencode, or your own command.'],
  ['Any language', 'It runs your project\'s own check. It never parses code.'],
  ['Owners decide', 'XTEND.md, GitHub settings and CONTRIBUTING.md say what forks may send.'],
  ['Gives back clean', 'Ports only the changes you pick onto upstream, one commit each. Never from CI, one open offer per project.'],
  ['Safe around agents', 'Git runs with hooks off. Changed git config, hooks or xtend settings get put back.'],
  ['Tune each step', 'Swap the agent, the prompt or a formatter per step in `~/.config/xtend`. No fork of xtend, no PR.'],
  ['No service', 'One file, no dependencies. Your GitHub fork holds everything.'],
]

const CHAPTERS = [
  ['Owner', ['The owner writes a ref sheet once']],
  ['Fork and change', ['You take your own copy', 'You make it yours']],
  ['Plain git', ['What plain git does with it', 'And the check after it']],
  ['xtend sync', ['xtend merges it for you', 'The check, on the merged code', 'And again tomorrow']],
  ['From memory', ['Throw the merge away', 'Merge it again from scratch']],
  ['Give back', ['A small fix the owner asked for', 'What upstream would take', 'Offer only that fix']],
]
const OPEN = ['What plain git does with it', 'xtend merges it for you', 'Merge it again from scratch']
const kind = (s) => s.status !== 0 ? 'bad' : /asking agent/.test(s.output) || s.title.startsWith('The owner writes') ? (s.who === 'owner' ? 'owner' : 'agent') : 'tool'
const pad = (n) => String(n).padStart(2, '0')
function runLog(a) {
  const longest = Math.max(...a.steps.map((x) => x.seconds))
  const agent = a.steps.filter((s) => kind(s) === 'agent' || kind(s) === 'owner').reduce((t, s) => t + s.seconds, 0)
  const failed = a.steps.filter((s) => s.status !== 0).length
  const n = (s) => a.steps.indexOf(s) + 1
  const strip = a.steps.map((s) => `<a class="x-tl-seg" data-kind="${kind(s)}" href="#run-${a.id}-${n(s)}" style="flex-grow:${Math.max(s.seconds, 0.6)}" title="${esc(`${pad(n(s))} ${s.title}, ${minutes(s.seconds)}`)}" tabindex="-1"><span>${pad(n(s))}</span></a>`).join('')
  const row = (s) => `
        <details class="x-log" id="run-${a.id}-${n(s)}"${OPEN.includes(s.title) ? ' open' : ''}>
          <summary><span class="x-log-row">
            <span class="x-log-n sd-faint">${pad(n(s))}</span>
            <span><span class="sd-badge"${s.who === 'owner' ? ' data-tone="extra"' : ''}>${s.who}</span></span>
            <span class="x-log-title">${esc(s.title)} <code class="sd-subtle">${esc(s.command.length > 60 ? cut(s.command) : s.command)}</code></span>
            <span class="sd-status" data-tone="${s.status === 0 ? 'success' : 'danger'}">${s.status === 0 ? 'ok' : `exit ${s.status}`}</span>
            <span class="x-log-dur"><span class="x-bar" data-kind="${kind(s)}"><i style="width:${Math.max(2, Math.round((s.seconds / longest) * 100))}%"></i></span><span class="sd-subtle x-log-t">${minutes(s.seconds)}</span></span>
          </span></summary>
          ${term(s.command, s.output)}
        </details>`
  return `
      <div class="x-cells x-cells-4 x-run-stats">
        <div class="x-cell"><span class="x-num">${minutes(total(a))}</span><span class="sd-label">End to end</span></div>
        <div class="x-cell"><span class="x-num">${minutes(agent)}</span><span class="sd-label">Agent at work</span></div>
        <div class="x-cell"><span class="x-num">${a.steps.length}</span><span class="sd-label">Steps</span></div>
        <div class="x-cell"><span class="x-num">${failed}</span><span class="sd-label">Failed steps, all plain git</span></div>
      </div>
      <div class="x-tl" aria-hidden="true">${strip}</div>
      <ul class="x-tl-key" aria-label="Timeline key">
        <li data-kind="agent">agent at work</li><li data-kind="owner">owner's agent</li><li data-kind="tool">git, xtend or check</li><li data-kind="bad">failed</li>
      </ul>
      <div class="x-logs">${CHAPTERS.map(([name, titles]) => {
        const steps = a.steps.filter((s) => titles.includes(s.title))
        return steps.length ? `
        <p class="sd-label x-chapter"><span>${name}</span><span class="sd-subtle">${minutes(steps.reduce((t, s) => t + s.seconds, 0))}</span></p>${steps.map(row).join('')}` : ''
      }).join('')}
      </div>
      <p class="sd-subtle x-rerun">Ran with <code>${esc(a.agent.split(' --')[0])}</code> on ${a.generated.slice(0, 10)}. Rerun it with <code>node demo/run.mjs ${a.id}</code>.</p>`
}

const reusedCount = (a) => Number((a.replay.output.match(/reused (\d+) resolution/) || [0, 0])[1])
const memory = (a) => (a.replay.agent ? 'agent fixed the rest' : `no agent · ${minutes(a.replay.seconds)}`)

const css = apps.map((a) => `html[data-app="${a.id}"] .x-app[data-app="${a.id}"]`).join(',\n')
const total = (a) => a.steps.reduce((t, s) => t + s.seconds, 0)

const html = `<!doctype html>
<html lang="en" data-theme="ink" data-app="${first}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>xTend: make any repo yours, keep getting upstream</title>
  <meta name="description" content="Your agent changes an open-source project however you want. xTend keeps merging upstream in, and resolves the conflicts by what your changes were for.">
  <meta property="og:title" content="xTend: make any repo yours, keep getting upstream">
  <meta property="og:description" content="Fork it, change it with your agent, keep getting upstream. Shown on ${apps.map((a) => a.lang).join(', ')} projects.">
  <meta property="og:image" content="https://medalink.github.io/xtend/img/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <script>
    try { const t = localStorage.getItem("sd-theme"); if (t) document.documentElement.dataset.theme = t } catch {}
    try { const a = new URLSearchParams(location.search).get("app") || localStorage.getItem("xtend-app"); if (${JSON.stringify(apps.map((a) => a.id))}.includes(a)) document.documentElement.dataset.app = a } catch {}
  </script>
  <link rel="stylesheet" href="vendor/signal/signal.css">
  <link rel="stylesheet" href="board.css">
  <style>.x-app { display: none }
${css} { display: block }</style>
  <script type="module">
    import { init } from "./vendor/signal/signal.js"; init()
    const root = document.documentElement
    const show = (id) => {
      root.dataset.app = id
      for (const b of document.querySelectorAll("[data-pick]")) b.setAttribute("aria-pressed", String(b.dataset.pick === id))
    }
    show(root.dataset.app)
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]")
      if (!b) return
      show(b.dataset.pick)
      try { localStorage.setItem("xtend-app", b.dataset.pick) } catch {}
      const u = new URL(location.href); u.searchParams.set("app", b.dataset.pick); history.replaceState(null, "", u)
    })
  </script>
</head>
<body>
<a class="sd-skip" href="#main">Skip to content</a>

<header class="sd-topbar x-top">
  <a class="sd-wordmark" href="#main">xTend</a>
  <nav class="sd-nav sd-desktop-only" aria-label="Site">
    <a href="#log">The run</a>
    <a href="#features">Features</a>
    <a href="#merge">The merge</a>
    <a href="#screens">Screens</a>
    <a href="#give">Give back</a>
    <a href="#owners">Owners</a>
  </nav>
  <div class="sd-topbar-end">
    <a class="sd-btn sd-btn-sm sd-btn-primary" href="${REPO}">GitHub</a>
  </div>
</header>

<main id="main" tabindex="-1">
  <section class="x-hero" aria-labelledby="hero-h">
    <div class="x-wrap x-hero-grid">
      <div class="x-hero-copy">
        <h1 id="hero-h" class="x-h1">Make any repo yours. <em>Keep getting upstream.</em></h1>
        <div class="x-stack">
          <p class="sd-lead">Your agent changes the project. xTend keeps merging upstream in, and settles every collision by what your change was for.</p>
          <div class="x-install">
            <span class="sd-faint" aria-hidden="true">$</span><code id="cmd">npx github:Medalink/xtend get owner/repo</code>
            <button class="sd-btn sd-btn-sm sd-btn-ghost" data-sd-copy="#cmd">Copy</button>
          </div>
          ${pick}
        </div>
      </div>
${each((a) => `
      <div class="x-window">
        <div class="sd-titlebar" role="region" aria-label="${esc(a.name)} run">
          <span class="sd-titlebar-brand"><b>${esc(a.name)}</b> <span class="sd-subtle">${esc(a.lang)}</span></span>
        </div>
        <div class="x-versus">
          <div class="x-cell">
            <span class="sd-label">git merge</span>
            <span class="x-num">${a.files.conflicted.length}<small> ${a.files.conflicted.length === 1 ? 'conflict' : 'conflicts'}</small></span>
            <span class="sd-status" data-tone="danger">check ${a.plain.checkPassed ? 'passes' : 'fails'}</span>
          </div>
          <div class="x-cell">
            <span class="sd-label">xtend sync</span>
            <span class="x-num">${minutes(a.sync.seconds)}</span>
            <span class="sd-status" data-tone="success">check passes</span>
          </div>
          <div class="x-cell">
            <span class="sd-label">Kept</span>
            <span class="x-num">${Object.values(a.kept.yours).filter(Boolean).length + Object.values(a.kept.upstream).filter(Boolean).length}<small> of ${Object.keys(a.kept.yours).length + Object.keys(a.kept.upstream).length}</small></span>
            <span class="sd-status" data-tone="success">features from both sides</span>
          </div>
          <div class="x-cell">
            <span class="sd-label">Again from scratch</span>
            <span class="x-num">${reusedCount(a)}<small> of ${a.files.conflicted.length}</small></span>
            <span class="sd-status" data-tone="${a.replay.agent ? 'pending' : 'success'}">remembered · ${esc(memory(a))}</span>
          </div>
        </div>
        <div class="x-window-shot">${screen(a, 'synced', 'Yours + 2.0')}</div>
      </div>`)}
    </div>
  </section>

  <section class="x-section" id="log" aria-labelledby="the-run-h">
    <div class="x-wrap">${head('01', 'The run', 'Every step, unedited.', 'Real agent, real output.')}
${each(runLog)}
    </div>
  </section>

  <section class="x-section" id="features" aria-labelledby="features-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>02</b> Features</p>
      <h2 id="features-h" class="x-h2">Your fork stays yours. <em>Upstream keeps coming.</em></h2>
      <div class="x-cells x-cells-4 x-features">${FEATURES.map(([t, d], i) => `
        <div class="x-cell"><span class="x-step">${String(i + 1).padStart(2, '0')}</span><h3 class="sd-title">${t}</h3><p class="sd-muted">${esc(d).replace(/`([^`]+)`/g, '<code>$1</code>')}</p></div>`).join('')}
      </div>
    </div>
  </section>

  <section class="x-section" id="merge" aria-labelledby="the-merge-h">
    <div class="x-wrap">${head('03', 'The merge', 'Both sides rewrote the same code.', 'Git stops. xTend finishes.')}
${each((a) => `
      <div class="x-split x-split-top">
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">You asked</span></div>
          <p class="x-quote">${esc(a.change)}</p>
        </div>
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">Upstream shipped</span></div>
          <p class="x-quote">${esc(a.upstream)}</p>
        </div>
      </div>
      <div class="x-frame x-gap">
        ${graph(a)}
        ${fileMap(a)}
      </div>
      <div class="x-split">
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">git merge upstream/main</span><span class="sd-status" data-tone="danger">${plural(a.files.conflicted.length, 'conflict')}</span></div>
          <div class="x-frame-body">${term(step(a, 'What plain git does with it').command, tail(step(a, 'What plain git does with it').output, 8))}${term(a.check, a.plain.check.split('\n').slice(0, 6).join('\n'))}</div>
        </div>
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">xtend sync</span><span class="sd-status" data-tone="success">merged · ${minutes(a.sync.seconds)}</span></div>
          <div class="x-frame-body">${term('xtend sync', tail(a.sync.output, 12))}</div>
        </div>
      </div>
      <div class="x-cells x-cells-2">${kept(a)}
      </div>
      <div class="x-frame x-gap">
        <div class="x-frame-head"><span class="sd-label">The same merge, done again</span><span class="sd-status" data-tone="${a.replay.agent ? 'pending' : 'success'}">${esc(memory(a))}</span></div>
        ${a.replay.agent ? `
        <ul class="sd-checks x-memory">
          <li data-tone="success"><span>git replayed ${a.files.conflicted.length === 1 ? 'the conflict resolution' : `all ${a.files.conflicted.length} conflict resolutions`} from memory:${a.files.conflicted.map((f) => `<code>${esc(f)}</code>`).join(', ')}</span></li>
          <li data-tone="pending"><span>The first merge also adapted your code to upstream's new API, in files git merges without a conflict. rerere only remembers conflicts, so the check failed and the agent fixed just that.</span></li>
        </ul>` : `
        <div class="x-race">
          <div class="x-race-row"><span class="sd-label">First time</span><span class="x-bar" data-kind="agent"><i style="width:100%"></i></span><span class="sd-subtle x-bar-n">${minutes(a.sync.seconds)}</span></div>
          <div class="x-race-row"><span class="sd-label">From memory</span><span class="x-bar" data-kind="tool"><i style="width:${Math.max(1, Math.round((a.replay.seconds / a.sync.seconds) * 100))}%"></i></span><span class="sd-subtle x-bar-n">${minutes(a.replay.seconds)}</span></div>
        </div>`}
        <div class="x-frame-body">${term('xtend sync', a.replay.output)}</div>
      </div>`)}
    </div>
  </section>

  <section class="x-section" id="screens" aria-labelledby="screens-h">
    <div class="x-wrap">${head('04', 'Screens', 'Four states of one app.', 'Same input each time.')}
${each((a) => `
      <div class="x-shots">${STATES.map(([s, label]) => screen(a, s, label)).join('')}</div>`)}
    </div>
  </section>

  <section class="x-section" id="give" aria-labelledby="give-back-h">
    <div class="x-wrap">${head('05', 'Give back', 'Offer what the owner asked for.', 'Only that.')}
${each((a) => `
      <div class="x-split">
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">The owner's XTEND.md</span></div>
          <p class="x-quote">${esc(a.wanted)}</p>
          <div class="x-frame-body">${term('xtend share', a.share)}</div>
        </div>
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">The offer</span><span class="sd-status" data-tone="success">upstream's check passes</span></div>
          <div class="x-frame-body">
            <p class="x-quote x-quote-in">${esc(a.fix)}</p>
            <ul class="x-files x-files-plain">${a.offer.files.map((f) => `<li class="x-file"><code>${esc(f.file)}</code><span class="x-bar" data-kind="offer"><i style="width:${Math.max(3, Math.min(100, (f.add + f.del) * 4))}%"></i></span><span class="x-bar-n sd-subtle">+${f.add} −${f.del}</span></li>`).join('')}</ul>
            ${a.offer.probe ? term(a.offer.probe.command, a.offer.probe.output) : ''}
            <ul class="sd-checks">
              <li data-tone="success">None of your ${esc(Object.keys(a.kept.yours).length)} customizations came along</li>
              <li data-tone="success">One commit, with its cherry-pick command</li>
            </ul>
            <details class="x-log"><summary>What the owner reads</summary><pre class="x-term x-sheet" tabindex="0" aria-label="The offer">${esc(a.offer.body)}</pre></details>
          </div>
        </div>
      </div>`)}
      <ul class="x-guards" aria-label="Limits on offers">
        <li class="sd-badge">A person picks every change</li>
        <li class="sd-badge">Never from CI</li>
        <li class="sd-badge">One open offer per project</li>
        <li class="sd-badge">Never re-offers what the owner closed</li>
        <li class="sd-badge">Stops where CONTRIBUTING.md says no</li>
      </ul>
    </div>
  </section>

  <section class="x-section" id="owners" aria-labelledby="owners-h">
    <div class="x-wrap">${head('06', 'Owners', 'Nothing to maintain.', 'One file if you want.')}
      <div class="x-split">
        <ul class="sd-checks x-owner">
          <li data-tone="success"><span><code>xtend sheet</code> writes <code>XTEND.md</code>, a map every agent reads first</span></li>
          <li data-tone="success"><span><code>contributions: pr</code>, <code>issue</code> or <code>none</code> decides what forks may send</span></li>
          <li data-tone="success"><span>The lines under it say what you would welcome</span></li>
          <li data-tone="success"><span>No sheet? Forks write their own, privately</span></li>
        </ul>
        <div>${each((a) => `
          <div class="x-frame">
            <div class="x-frame-head"><span class="sd-label">XTEND.md</span><span class="sd-subtle">${esc(a.name)}, written by xtend sheet</span></div>
            <pre class="x-term x-sheet" tabindex="0" aria-label="XTEND.md for ${esc(a.name)}">${esc(a.sheet)}</pre>
          </div>`)}
        </div>
      </div>
    </div>
  </section>

  <section class="x-cta" aria-labelledby="cta-h">
    <div class="x-wrap x-stack">
      <h2 id="cta-h" class="x-h1">Fork less. <em>Extend more.</em></h2>
      <div class="sd-actions">
        <a class="sd-btn sd-btn-lg sd-btn-primary" href="${REPO}">Get xTend</a>
        <a class="sd-btn sd-btn-lg" href="${REPO}/blob/main/xtend.mjs">Read the code</a>
      </div>
      <p class="sd-subtle">From <a href="${TWEET}">an idea by Thariq</a>.</p>
    </div>
  </section>
</main>

<footer class="x-wrap x-foot">
  <span class="sd-subtle">MIT · built with <a href="https://github.com/Medalink/signal-design">Signal</a></span>
  <div class="sd-seg" aria-label="Theme">
    <button type="button" data-sd-theme="ink">ink</button>
    <button type="button" data-sd-theme="graphite">graphite</button>
    <button type="button" data-sd-theme="paper">paper</button>
  </div>
</footer>
</body>
</html>
`

fs.writeFileSync(path.join(DOCS, 'index.html'), html)
console.log(`wrote docs/index.html (${html.length} bytes)`)
