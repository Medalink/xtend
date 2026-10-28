import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(here, '..', 'docs')
const REPO = 'https://github.com/Medalink/xtend'
const TWEET = 'https://x.com/trq212/status/2115188992861970693'
const d = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'demo.json'), 'utf8'))

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const stat = (s) => {
  const n = (re) => Number((s.match(re) || [0, 0])[1])
  return { files: n(/(\d+) files? changed/), plus: n(/(\d+) insertion/), minus: n(/(\d+) deletion/) }
}
const yours = stat(d.divergence)
const theirs = stat(d.upstreamChange)
const step = (title) => d.steps.find((s) => s.title === title)
const plain = step('What plain git does with it')
const plainTests = step('And the tests after it')
const sync = step('xtend merges it for you')
const after = step('Upstream tests and yours, on the merged code')
const shareList = step('What upstream would take')
const shareSend = step('Offer only that fix')
const conflicts = d.plain.conflicted.length
const minutes = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s}s`)
const total = d.steps.reduce((a, s) => a + s.seconds, 0)
const day = d.generated.slice(0, 10)
const agentName = d.agent.split(' ')[0]

const fileRows = d.forkFiles.split('\n').filter(Boolean).map((l) => {
  const [k, f, to] = l.split('\t')
  const tone = { A: 'success', D: 'danger', M: 'pending', R: 'warning' }[k[0]] || ''
  const word = { A: 'added', D: 'deleted', M: 'rewritten', R: 'moved and rewritten' }[k[0]] || k
  const name = to ? `${esc(f)}</code> → <code>${esc(to)}` : esc(f)
  return `<li data-tone="${tone}"><span><code>${name}</code> <span class="sd-subtle">${word}</span></span></li>`
}).join('')

const yoursKept = ['Deep work 50 min', 'progress ring', 'keyboard shortcuts', 'app.js stays deleted']
const upstreamKept = ['long break every 4', 'session dots', 'chime']
const KEPT_LABEL = {
  'Deep work 50 min': '"Deep work" is 50 minutes, "Recharge" is 10',
  'progress ring': 'Dark full-screen layout with the SVG progress ring',
  'keyboard shortcuts': 'Space, R, 1 and 2 still work',
  'app.js stays deleted': '<code>app.js</code> stays gone. Upstream\'s changes to it landed in <code>ui.js</code>',
  'long break every 4': 'A long break after every 4th session (<code>nextPreset</code>)',
  'session dots': 'Session dots and the "done today" count',
  chime: 'The chime when a session ends',
}
const checks = (keys) => keys.map((k) => `<li data-tone="${d.kept[k] ? 'success' : 'danger'}"><span>${KEPT_LABEL[k]}</span></li>`).join('')

const term = (s, lines = 40, head = false) => {
  const all = s.output.split('\n')
  const out = (head ? all.slice(0, lines) : all.slice(-lines)).join('\n')
  return `<pre class="x-term" tabindex="0"><span class="sd-faint">$</span> ${esc(s.command)}\n${esc(out)}</pre>`
}

const EX_DIR = path.join(DOCS, 'data', 'examples')
const examples = fs.existsSync(EX_DIR) ? fs.readdirSync(EX_DIR).map((f) => JSON.parse(fs.readFileSync(path.join(EX_DIR, f), 'utf8'))) : []
const exStep = (e, title) => e.steps.find((s) => s.title === title)
const keptList = (e) => ['yours', 'upstream'].flatMap((side) => Object.entries(e.kept[side]).map(([k, ok]) =>
  `<li data-tone="${ok ? 'success' : 'danger'}"><span>${esc(k)} <span class="sd-subtle">${side === 'yours' ? 'yours' : 'upstream'}</span></span></li>`)).join('')
const exampleCards = examples.map((e) => {
  const merged = exStep(e, 'xtend merges it for you')
  const n = e.plain.conflicted.length
  return `
        <article class="x-cell x-lang">
          <p class="x-lang-head"><span class="sd-badge">${esc(e.lang)}</span> <span class="sd-label">${esc(e.name)}</span></p>
          <p class="sd-muted">${esc(e.about)}</p>
          <dl class="sd-kv x-lang-kv">
            <dt>You asked</dt><dd>${esc(e.change)}</dd>
            <dt>Upstream</dt><dd>${esc(e.upstream)}</dd>
            <dt>Check</dt><dd><code>${esc(e.check)}</code></dd>
          </dl>
          <p class="x-lang-stats">
            <span class="sd-status" data-tone="${n ? 'danger' : 'pending'}">git: ${n ? `${n} conflict${n === 1 ? '' : 's'}` : 'merged'}, check ${e.plain.checkPassed ? 'passes' : 'fails'}</span>
            <span class="sd-status" data-tone="success">xtend: merged in ${minutes(merged.seconds)}, check passes</span>
          </p>
          <ul class="sd-checks">${keptList(e)}</ul>
          <details class="x-log"><summary>xtend sync output</summary>${term(merged, 20)}</details>
        </article>`
}).join('')

const shots = [
  ['1-upstream', 'pomo 1.0', 'Upstream, the day you fork it.'],
  ['2-yours', 'Yours', 'One sentence to your agent: dark, ring, 50 minutes, shortcuts, new file layout.'],
  ['3-upstream-v2', 'pomo 2.0', 'Upstream ships long breaks, session dots and a chime, and renames modes to presets.'],
  ['4-synced', 'Yours + 2.0', 'After <code>xtend sync</code>. Your design, their features, both test suites green.'],
]

const runLog = d.steps.map((s, i) => `
      <details class="x-log">
        <summary><span class="x-log-row">
          <span class="x-log-n sd-faint">${String(i + 1).padStart(2, '0')}</span>
          <span><span class="sd-badge"${s.who === 'owner' ? ' data-tone="extra"' : ''}>${s.who}</span></span>
          <span class="x-log-title">${esc(s.title)} <code class="sd-subtle">${esc(s.command.length > 60 ? s.command.slice(0, 57) + '..."' : s.command)}</code></span>
          <span class="sd-status" data-tone="${s.status === 0 ? 'success' : 'danger'}">${s.status === 0 ? 'ok' : `exit ${s.status}`}</span>
          <span class="sd-subtle x-log-t">${minutes(s.seconds)}</span>
        </span></summary>
        ${term(s, 200)}
      </details>`).join('')

const html = `<!doctype html>
<html lang="en" data-theme="ink">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>xTend: make any repo yours, keep getting upstream</title>
  <meta name="description" content="Your agent changes an open-source project however you want. xTend keeps merging upstream in, and resolves the conflicts by what your changes were for.">
  <meta property="og:title" content="xTend: make any repo yours, keep getting upstream">
  <meta property="og:description" content="Fork, bend it with your agent, and keep getting upstream. Plain git hit ${conflicts} conflicts in this demo. xTend merged it and both test suites passed.">
  <meta property="og:image" content="https://medalink.github.io/xtend/img/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <script>try { const t = localStorage.getItem("sd-theme"); if (t) document.documentElement.dataset.theme = t } catch {}</script>
  <link rel="stylesheet" href="vendor/signal/signal.css">
  <link rel="stylesheet" href="board.css">
  <script type="module">import { init } from "./vendor/signal/signal.js"; init()</script>
</head>
<body>
<a class="sd-skip" href="#main">Skip to content</a>

<header class="sd-topbar x-top">
  <a class="sd-wordmark" href="#main">xTend</a>
  <nav class="sd-nav sd-desktop-only" aria-label="Site">
    <a href="#hard">The hard case</a>
    <a href="#langs">Languages</a>
    <a href="#states">Screens</a>
    <a href="#how">How it works</a>
    <a href="#owners">Owners</a>
    <a href="#give">Give back</a>
    <a href="#log">Run log</a>
  </nav>
  <div class="sd-topbar-end">
    <a class="sd-btn sd-btn-sm sd-btn-primary" href="${REPO}">GitHub</a>
  </div>
</header>

<main id="main" tabindex="-1">
  <section class="x-hero">
    <div class="x-wrap x-hero-grid">
      <div class="x-hero-copy">
        <div>
          <span class="sd-badge" data-tone="success">Real run · ${day} · ${agentName}</span>
          <h1 class="x-h1">Make any repo yours. <em>Keep getting upstream.</em></h1>
        </div>
        <div class="x-stack">
          <p class="sd-lead">Your agent changes an open-source project however you want. xTend keeps merging upstream in, and when the two collide, it resolves them by what your changes were for.</p>
          <div class="x-install">
            <span class="sd-faint" aria-hidden="true">$</span><code id="cmd">npx github:Medalink/xtend get owner/repo</code>
            <button class="sd-btn sd-btn-sm sd-btn-ghost" data-sd-copy="#cmd">Copy</button>
          </div>
        </div>
      </div>

      <div class="x-window" data-sd-ornaments data-sd-ornaments-size="160">
        <div class="sd-titlebar" role="region" aria-label="Window">
          <span class="sd-titlebar-brand"><b>xtend sync</b></span>
          <div class="sd-titlebar-end">
            <span class="sd-titlebar-metric sd-desktop-only">PLAIN GIT <b>${conflicts} CONFLICTS</b></span>
            <span class="sd-titlebar-metric sd-desktop-only">XTEND <b>${minutes(sync.seconds)}</b></span>
          </div>
        </div>
        <div class="x-window-body">
          <div class="x-window-main">
            ${term(sync)}
            ${term(after)}
            <ul class="sd-checks">
              <li data-tone="success">${conflicts} conflicted files resolved by intent</li>
              <li data-tone="success">Upstream's new tests pass on your redesign</li>
              <li data-tone="success">The next sync is a no-op</li>
            </ul>
          </div>
          <a class="x-window-shot" href="states/4-synced/index.html">
            <img src="img/4-synced.png" alt="The merged app: the fork's dark ring design with upstream's session dots" width="1200" height="800">
          </a>
        </div>
      </div>
    </div>
  </section>

  <section class="x-section" id="hard" aria-labelledby="hard-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>01</b> The hard case</p>
      <h2 id="hard-h" class="x-h2">You rewrote the app. <em>Upstream rewrote it too.</em></h2>
      <p class="sd-lead x-measure">The fork moved all of the DOM code from <code>app.js</code> into a new <code>ui.js</code>, restyled it and renamed the modes. Upstream then shipped a feature through <code>app.js</code> and renamed modes to presets. Git follows the move, then stops on ${conflicts} of ${yours.files} files, and the tests crash on conflict markers. Fixing that by hand means understanding both sides.</p>

      <div class="x-cells x-cells-4">
        <div class="x-cell"><span class="x-num">+${yours.plus}<small> −${yours.minus}</small></span><span class="sd-label">Your change, ${yours.files} files</span></div>
        <div class="x-cell"><span class="x-num">+${theirs.plus}<small> −${theirs.minus}</small></span><span class="sd-label">Upstream 2.0, ${theirs.files} files</span></div>
        <div class="x-cell"><span class="x-num">${conflicts}<small> of ${Math.max(yours.files, theirs.files)}</small></span><span class="sd-label">Files plain git can't merge</span><span class="sd-status" data-tone="danger">tests ${d.plain.testsPassed ? 'pass' : 'fail'}</span></div>
        <div class="x-cell"><span class="x-num">0</span><span class="sd-label">Left for you after xtend sync</span><span class="sd-status" data-tone="success">tests pass</span></div>
      </div>

      <div class="x-split">
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">git merge upstream/main</span><span class="sd-status" data-tone="danger">${conflicts} conflicts</span></div>
          <div class="x-frame-body">${term(plain)}${term(plainTests, 5, true)}</div>
        </div>
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">xtend sync</span><span class="sd-status" data-tone="success">merged · ${minutes(sync.seconds)}</span></div>
          <div class="x-frame-body">${term(sync)}${term(after, 8)}</div>
        </div>
      </div>

      <div class="x-cells x-cells-3">
        <div class="x-cell">
          <p class="sd-label">What your one sentence did</p>
          <ul class="sd-checks">${fileRows}</ul>
        </div>
        <div class="x-cell">
          <p class="sd-label">Kept from you</p>
          <ul class="sd-checks">${checks(yoursKept)}</ul>
        </div>
        <div class="x-cell">
          <p class="sd-label">Kept from upstream</p>
          <ul class="sd-checks">${checks(upstreamKept)}</ul>
        </div>
      </div>

      <div class="x-cells x-cells-3">
        <div class="x-cell">
          <span class="x-step">01</span>
          <h3 class="sd-title">Intent, not lines</h3>
          <p class="sd-muted">Each customization is a commit whose message says what you wanted. The agent reads those, so it rebuilds "dark, ring, 50 minutes" on top of the new code instead of picking hunks.</p>
        </div>
        <div class="x-cell">
          <span class="x-step">02</span>
          <h3 class="sd-title">Both test suites decide</h3>
          <p class="sd-muted">Upstream's tests came with the merge. xTend runs your check after every attempt and sends the failures back to the agent. Nothing is committed until it passes.</p>
        </div>
        <div class="x-cell">
          <span class="x-step">03</span>
          <h3 class="sd-title">Or nothing changes</h3>
          <p class="sd-muted">If three tries don't produce a clean, passing tree, xTend puts everything back as it was and exits non-zero. A failed sync never leaves a half-merge behind.</p>
        </div>
      </div>
    </div>
  </section>

${examples.length ? `
  <section class="x-section" id="langs" aria-labelledby="langs-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>02</b> Any language</p>
      <h2 id="langs-h" class="x-h2">${examples.map((e) => e.lang).join(', ').replace(/, ([^,]*)$/, ' and $1')}. <em>Same story.</em></h2>
      <p class="sd-lead x-measure">Each project got one sentence from its fork, then an upstream release that rewrote the same code. xTend knows nothing about these languages. It runs the project's own check, and the agent does the rest.</p>
      <div class="x-cells x-cells-${examples.length}">${exampleCards}
      </div>
    </div>
  </section>
` : ''}
  <section class="x-section" id="states" aria-labelledby="states-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>03</b> Screens</p>
      <h2 id="states-h" class="x-h2">Four states of one app. <em>Click any to run it.</em></h2>
      <div class="x-shots">
        ${shots.map(([id, name, sub]) => `
        <a class="x-shot" href="states/${id}/index.html">
          <span class="x-shot-head"><span class="sd-label">${name}</span><span class="sd-subtle">open</span></span>
          <img src="img/${id}.png" alt="${esc(name)}" width="1200" height="800" loading="lazy">
          <span class="x-shot-sub sd-muted">${sub}</span>
        </a>`).join('')}
      </div>
    </div>
  </section>

  <section class="x-section" id="how" aria-labelledby="how-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>04</b> How it works</p>
      <h2 id="how-h" class="x-h2">Five commands. <em>Tools you already have.</em></h2>
      <div class="x-cells x-cells-5">
        <div class="x-cell"><code class="x-cmd">xtend get owner/repo</code><p class="sd-muted">Forks it on GitHub, clones it and writes the ref sheet. It also turns on a daily Action that runs <code>xtend sync</code> for you.</p></div>
        <div class="x-cell"><code class="x-cmd">xtend "make it dark"</code><p class="sd-muted">Your agent makes the change with the ref sheet in hand. Your check has to pass, and the commit message keeps what you asked for.</p></div>
        <div class="x-cell"><code class="x-cmd">xtend sync</code><p class="sd-muted">Merges upstream with git. When git can't finish, the agent does, guided by your intent. It retries until the check passes, or nothing changes.</p></div>
        <div class="x-cell"><code class="x-cmd">xtend sheet</code><p class="sd-muted">Reads the code and writes a short map for agents: layout, commands, where to extend, and which files churn.</p></div>
        <div class="x-cell"><code class="x-cmd">xtend share</code><p class="sd-muted">Shows what upstream accepts. Then it ports the changes you pick onto upstream's code and offers them the way the owner asks.</p></div>
      </div>
      <dl class="sd-kv x-kv">
        <dt>Storage</dt><dd>Your GitHub fork. No service, no database, no account.</dd>
        <dt>Merging</dt><dd><code>git merge</code>, with <code>rerere</code> on</dd>
        <dt>Intent</dt><dd>Your commit messages</dd>
        <dt>Agent</dt><dd>Claude Code, Codex, Gemini, Amp, opencode, or any command: <code>xtend agent &lt;name or command&gt;</code></dd>
        <dt>Gate</dt><dd>Your <code>check</code> command, such as <code>npm test</code></dd>
        <dt>Giving back</dt><dd>One draft PR or issue through <code>gh</code>, only where the owner allows it</dd>
        <dt>Size</dt><dd>One file, no dependencies</dd>
      </dl>
    </div>
  </section>

  <section class="x-section" id="owners" aria-labelledby="owners-h">
    <div class="x-wrap x-split">
      <div>
        <p class="sd-label x-kicker"><b>05</b> Owners</p>
        <h2 id="owners-h" class="x-h2">Nothing to maintain. <em>One file if you want.</em></h2>
        <p class="sd-lead">Your project works with xTend as it is. To help people who extend it, run <code>xtend sheet</code> once and commit <code>XTEND.md</code>. It works like a spec sheet instead of an MCP server: every agent reads it before every change and every merge. Its <code>contributions:</code> line says whether forks may send you a pull request, an issue or nothing, and what you would welcome.</p>
      </div>
      <div class="x-frame">
        <div class="x-frame-head"><span class="sd-label">XTEND.md</span><span class="sd-subtle">written by xtend sheet in this run</span></div>
        <pre class="x-term x-sheet" tabindex="0" aria-label="XTEND.md">${esc(d.sheet || '')}</pre>
      </div>
    </div>
  </section>

  <section class="x-section" id="give" aria-labelledby="give-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>06</b> Give back</p>
      <h2 id="give-h" class="x-h2">Offer what the owner wants. <em>Only that.</em></h2>
      <p class="sd-lead x-measure">The owner's <code>XTEND.md</code> says they welcome accessibility fixes. You made one on top of your redesign. <code>xtend share</code> ports just that fix onto upstream's own code, without your redesign, and upstream's tests pass on it.</p>
      <div class="x-split">
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">xtend share</span><span class="sd-subtle">sends nothing</span></div>
          <div class="x-frame-body">${term(shareList)}${term(shareSend, 12)}</div>
        </div>
        <div class="x-frame">
          <div class="x-frame-head"><span class="sd-label">The offer, as the owner reads it</span><span class="sd-status" data-tone="success">upstream tests pass</span></div>
          <pre class="x-term x-sheet" tabindex="0" aria-label="The offer">${esc(d.offer.body)}</pre>
        </div>
      </div>
      <div class="x-cells x-cells-3">
        <div class="x-cell">
          <span class="x-step">01</span>
          <h3 class="sd-title">The owner decides</h3>
          <p class="sd-muted">xTend reads <code>XTEND.md</code>, GitHub's settings and <code>CONTRIBUTING.md</code> before it builds anything. It quotes the line that says no, and stops. Nothing you pass overrides it.</p>
        </div>
        <div class="x-cell">
          <span class="x-step">02</span>
          <h3 class="sd-title">Pick, don't merge</h3>
          <p class="sd-muted">Each change is one commit on upstream's latest code, with the cherry-pick command under it. The owner takes one, some or all.</p>
        </div>
        <div class="x-cell">
          <span class="x-step">03</span>
          <h3 class="sd-title">No floods</h3>
          <p class="sd-muted">A person picks every change. xTend never offers from CI and keeps one open offer per project. It never re-offers what the owner closed.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="x-section" id="log" aria-labelledby="log-h">
    <div class="x-wrap">
      <p class="sd-label x-kicker"><b>07</b> Run log</p>
      <h2 id="log-h" class="x-h2">Every step, unedited. <em>${minutes(total)} end to end.</em></h2>
      <p class="sd-muted x-measure">This is real output from <code>demo/run.mjs</code>, with the real agent (<code>${esc(d.agent.split(' --')[0])}</code>). Run it yourself with <code>node demo/run.mjs</code>.</p>
      <div class="x-logs">${runLog}
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
      <p class="sd-subtle">From <a href="${TWEET}">an idea by Thariq</a>: modify software with agents and get upstream merged in automatically.</p>
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
