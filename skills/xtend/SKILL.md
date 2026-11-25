---
name: xtend
description: Keep a customized fork of an open-source project with upstream merged in, and offer changes back, using the xtend CLI. Use when the user wants their own version of a GitHub repo, wants to pull upstream into a fork they changed, or wants to send some of their fork's changes to the original project.
---

# xtend

`xtend` is a CLI. Run it with `npx github:Medalink/xtend <command>` if `xtend` is not on the PATH. Inside a fork, `node .xtend/xtend.mjs <command>` also works.

## Commands

- `xtend get <owner/repo>` forks and clones the project and writes `.xtend/`. Add `--daily` only if the user wants a GitHub Action to sync every day.
- `xtend daily [on|off]` shows, adds or removes that Action. Turning it on commits and pushes a workflow to the user's fork, so ask first.
- `xtend agent [preset or command]` shows or sets which agent CLI xtend runs: `claude`, `codex`, `gemini`, `amp`, `opencode`, or any command that reads the prompt on stdin or from `{file}`.
- `xtend config [--json]` shows each step's agent, prompt, `add`, `after` and `tries`, and the file that set each one. Change them for one machine in `~/.config/xtend/config.json`. Only `.xtend/config.json` reaches the daily Action.
- `xtend sync` merges upstream. Conflicts git has resolved before are reused without the agent. When it fails it resets to where it started and exits non-zero. Report its message to the user. Never commit the merge yourself; see "Syncing yourself" for the way to resolve one.
- `xtend update` refreshes `.xtend/xtend.mjs`, the copy the daily Action runs, from the xtend you ran it with.
- `xtend share --json` prints what upstream accepts (`takes` is `pr`, `issue` or `null`, with the reasons in `notes`) and a numbered list of the user's changes.
- `xtend share <n>... --yes` ports those changes onto upstream and opens one draft PR or issue.

## Start here

Run `xtend status` before anything else (`--json` to read it as data). One call says how far this copy is behind upstream and ahead of it, whether upstream itself trails the repo it was forked from (`root`), whether a sync is open, which of upstream's files this copy has changed, whether every seam is still held, which temporary fixes are carried, the prepare, check and verify commands, and what the last sync brought in. It exits 2 when a seam is gone or a sync is open.

## Seams

When your change needs a line inside one of upstream's files (the call, import or list entry that hooks your code in, or a line of upstream's that your code relies on), record it: `xtend seam <file> "<exact text>" -m "<what it hooks in>"`, then `xtend commit` as usual. Upstream can rewrite around such a line and the merge stays clean, with the feature silently unhooked. Every check looks for each seam first, so a commit or a sync that loses one stops and names it. Keep the text short and exact: one line, no leading spaces. `xtend seams` lists them, and `xtend status` lists the files of upstream's you changed that have no seam yet: record one for each, unless a command rewrites the file, in which case add it to `generated` in `.xtend/config.json`. When a seam is gone after a sync, put it back where upstream's new code calls for it, or `xtend seam --drop <file> "<text>"` if the change no longer needs it.

## Making a change yourself

You are the agent, so edit the code directly instead of running `xtend "<request>"`. Read `XTEND.md` or `.xtend/sheet.md` first. Prefer new files and small edits to files that upstream changes often.

Record each change on its own with `xtend commit "<what the user asked for>" -m "<what you changed and why>"`. Add `-- <path>...` when the working tree holds more than one change. It runs the project's check, commits as `xtend: <request>` and pushes. If the check fails it exits 2 and commits nothing: fix the problem and run it again. Do not run `git commit` yourself. Later merges rely on that message to keep the change working, and the check is what keeps a bad change out.

## Temporary fixes

When the user wants something fixed that upstream should fix itself (a broken build, a type error, an upstream bug), record it as a temporary fix so xtend drops it once upstream no longer needs it: `xtend commit "<what you fixed>" -m "<why>" --proof "<command>"`. The proof is a command that passes with your fix and would fail without it today, such as the typecheck or the one test that covers the bug. Use `--temp` without a proof only when no command can tell; then the fix stays until its files match upstream. Keep each temporary fix in its own commit and as small as you can.

`xtend temp` lists the temporary fixes still carried. `xtend temp --try` drops the ones whose proof now passes without them. Sync does the same for the files upstream touched. A proof that fails even with the fix in place cannot say whether the fix is still needed, and xtend names it. Right after a sync the usual cause is new breakage from upstream: fix that, then run `xtend temp --try`. If the proof itself stopped running (a renamed script, say), `xtend temp --proof <commit> "<command>"` gives the fix a new one. Never revert or edit a temporary fix by hand to make a merge easier.

If `xtend sync --prompt` stops with no conflicts and a failing check, upstream broke itself. Fix it, then finish with `xtend sync --continue --temp "<what you fixed>" --proof "<command>"`.

## Writing the ref sheet yourself

`xtend get` and `xtend sheet` start an agent CLI to write the sheet. If none can run where you are, `get` still sets up and pushes the copy, then says there is no ref sheet yet. Write it yourself: run `xtend sheet --prompt`, do what it prints, and commit only that file with `git commit -m "xtend: write ref sheet"`.

## Syncing yourself

If no agent CLI can run where you are, `xtend sync` cannot resolve a conflict. Run `xtend sync --prompt` instead. A clean merge finishes on its own. Otherwise it exits 2 with the merge left open and prints what to do: the local customizations, what upstream changed, and what is wrong. Edit the files to resolve it, then run `xtend sync --continue`. It checks for conflict markers, runs the check, commits the merge and pushes. If it prints a problem and exits 2 again, fix that and run it again. `xtend sync --abort` puts everything back. Do not run `git commit` or `git merge --abort` yourself.

A sync runs the repo's `prepare` command once the merge is in the tree (installing what new upstream code needs), then the check, then `verify` (the slow gate: a typecheck or a build). Nothing is committed or pushed until all three pass, and `--continue` runs them again. When it finishes, sync prints what came in: how many commits and files, which of them are upstream files this copy changed, and any host named in the incoming lines that this copy had not named before. Read those files and look at any new host before you tell the user the sync is done.

## Upstream that is itself a fork

When `.xtend/config.json` names a `root`, upstream was forked from it. `xtend status` shows how far upstream and this copy each trail the root. `xtend sync --root --prompt` merges the root directly and works like any other sync; with `"syncRoot": true` a plain sync takes upstream and then the root, one merge at a time, so run `xtend sync --prompt` again after each `--continue` until it says it is up to date. Expect the root to carry what upstream removed: when the check blocks something the root brought back, remove it again the way upstream did, and never loosen the check to get a merge through.

## Unattended syncs

Where the agent is set to `none`, `xtend sync` lands a sync that merges and passes by itself and otherwise changes nothing, exits 3 and prints what stood in the way (as a GitHub Action it also opens or adds to the issue "xtend: the daily sync needs a hand"). If you are asked to deal with one, run `xtend sync --prompt` and finish it as above.

## Giving back

- Run `xtend share --json` and show the user what upstream takes and what they could offer.
- Run `xtend share` with numbers and `--yes` only when the user asked, in this conversation, to offer those specific changes.
- Never pass `--signoff` for the user. A DCO sign-off is their legal statement, so ask them.
- If `takes` is `null`, tell the user why and stop. Do not open a PR or issue another way.
- Never touch `.git/config` or `.git/hooks`. xtend restores them and stops if they change.
