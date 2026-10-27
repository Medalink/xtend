# xTend

Make any open-source repo yours, and keep getting upstream.

Your agent changes the project however you want. xTend keeps merging upstream in, and when the two collide, it resolves them by what your changes were for.

**[See it run →](https://medalink.github.io/xtend/)**

![xTend board: plain git hits 3 conflicts, xtend sync merges and both test suites pass](docs/img/board-hero.png)

```sh
npx github:Medalink/xtend get owner/repo   # fork + clone, write the ref sheet, turn on daily auto-sync
cd repo
xtend "add a dark mode toggle"             # your agent makes the change and commits it
xtend sync                                 # merge upstream now; your agent resolves any conflicts
```

## The hard case

In the [demo](https://medalink.github.io/xtend/#hard), a fork rewrites a Pomodoro app from one sentence. It goes dark, gets a progress ring, 50-minute sessions and keyboard shortcuts, and the DOM code moves from `app.js` into `ui.js`. Upstream then ships long breaks, session tracking and a chime through `app.js`, and renames modes to presets.

`git merge` stops on 3 of 5 files, and the tests crash on conflict markers. `xtend sync` merges it on the agent's first try. Both sides survive, and upstream's new tests pass on the redesigned code.

| Upstream 2.0 | Yours, after `xtend sync` |
|---|---|
| ![upstream](docs/img/3-upstream-v2.png) | ![synced](docs/img/4-synced.png) |

Every number and transcript on the board comes from a real run of `node demo/run.mjs`.

## Owners

Nothing is required. To help people who extend your project, run `xtend sheet` and commit the `XTEND.md` it writes: a short map of the code, the build and test commands, where to add things, and which files churn. Agents read it before every change and every merge. If a project has none, `xtend get` writes its own into `.xtend/sheet.md`.

## How it works

It uses tools you already have. Nothing runs as a service.

- **GitHub** holds your fork. `gh repo fork` creates it, and a GitHub Action in it runs `xtend sync` every day.
- **git** does the merging. Commit messages hold the intent of each customization, and `rerere` remembers past resolutions.
- **Your agent CLI** handles what git can't. That's `claude -p` by default, or `codex exec`, or anything in `XTEND_AGENT`. It sees the ref sheet, what you changed and why, and what upstream changed.
- **Your check** gates every change and merge. Set `"check": "npm test"` in `.xtend/config.json`.

## Safety

- The agent edits files. With the default `claude -p` command, the only shell commands it may run are `git rm` and `git mv`. Claude Code also blocks writes to `.git/`. Other agents get the same rules in their prompt, but their own sandbox enforces them. xTend owns every commit, merge and push.
- Hooks and git config run code on xTend's next git command. If any agent changes `.git/config` or `.git/hooks`, xTend puts them back and stops.
- A sync is accepted only if the merge is still in progress, no conflict markers are left, and your check passes. xTend makes up to three tries and feeds each failure back to the agent.
- Otherwise xTend resets to exactly where you were and exits non-zero, so the Action fails and GitHub emails you. A failed push also exits non-zero.
- xTend refuses to start with uncommitted or untracked files, so a rollback can never take your work with it.

## Auto-sync setup

`xtend get` adds `.github/workflows/xtend.yml` to your fork and turns on Actions. It needs one secret:

```sh
gh secret set ANTHROPIC_API_KEY -R you/repo
```

GitHub's default `GITHUB_TOKEN` can't push upstream commits that touch `.github/workflows/`. When that happens the run fails. Run `xtend sync` locally, or give the workflow a token with `workflow` scope.

## Files in your fork

- `.xtend/config.json` holds the upstream URL, branch, agent command and check command.
- `.xtend/sheet.md` is the generated ref sheet. It is skipped when upstream ships `XTEND.md`.
- `.xtend/xtend.mjs` is a copy of this tool, which the Action runs, so CI needs no install step.

## Develop

```sh
node test/e2e.mjs        # fake agent, local repos, every success and failure path (~40s)
node demo/run.mjs        # the real demo with your agent (~4 min), writes docs/data and docs/states
node demo/board.mjs      # rebuilds docs/index.html from that run
node demo/shoot.mjs      # screenshots into docs/img (needs playwright in tools/)
```

The board uses [Signal](https://github.com/Medalink/signal-design) v1.2.0, vendored in `docs/vendor/signal`.

Inspired by [Thariq's post](https://x.com/trq212/status/2115188992861970693) about distributing software that people modify with agents while upstream merges in automatically.

MIT
