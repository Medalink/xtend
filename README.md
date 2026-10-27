# xTend

Keep your own version of any open-source repo. Your agent changes it however you like, and upstream keeps merging in on its own.

```sh
xtend get owner/repo              # fork + clone, write the ref sheet, turn on daily auto-sync
cd repo
xtend "add a dark mode toggle"    # your agent makes the change and commits it
xtend sync                        # merge upstream now; your agent resolves any conflicts
```

## Owners

Nothing is required. To help extenders, run `xtend sheet` in your repo and commit the `XTEND.md` it writes: a short map of the code, the build and test commands, where to add things, and which files churn. Agents read it before every change and every merge. Without one, `xtend get` writes its own into `.xtend/sheet.md`.

## How it works

It uses tools you already have. Nothing runs as a service.

- **GitHub** holds your fork. `gh repo fork` creates it, and a GitHub Action in it runs `xtend sync` every day.
- **git** does the merging. Commit messages hold the intent of each customization, and `rerere` remembers past resolutions.
- **Your agent CLI** handles what git can't. That's `claude -p` by default, or `codex exec`, or anything in `XTEND_AGENT`. It sees the ref sheet, what you changed and why, and what upstream changed. It edits files only. xtend owns the merge.
- **Your check** gates every change and merge. Set `"check": "npm test"` in `.xtend/config.json`.

If a sync can't produce a clean tree that passes the check in two tries, xtend puts everything back the way it was and exits nonzero, so the Action fails and GitHub emails you.

## Auto-sync setup

`xtend get` adds `.github/workflows/xtend.yml` to your fork and turns on Actions. It needs one secret:

```sh
gh secret set ANTHROPIC_API_KEY -R you/repo
```

Upstream commits that touch `.github/workflows/` can't be pushed with the default `GITHUB_TOKEN`. If that happens, run `xtend sync` locally, or give the workflow a token with `workflow` scope.

## Files in your fork

- `.xtend/config.json` holds the upstream URL, branch, agent command and check command.
- `.xtend/sheet.md` is the generated ref sheet. It is skipped when upstream ships `XTEND.md`.
- `.xtend/xtend.mjs` is a copy of this tool, which the Action runs. No install step is needed in CI.

## Test

```sh
node test/e2e.mjs
```

The test runs a fake agent against local repos. It covers a change, a conflicting sync, a no-op sync, a clean sync, and a failed sync that must roll back.
