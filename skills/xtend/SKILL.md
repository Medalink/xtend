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
- `xtend sync` merges upstream. Conflicts git has resolved before are reused without the agent. When it fails it resets to where it started and exits non-zero. Report its message to the user. Do not finish the merge by hand.
- `xtend share --json` prints what upstream accepts (`takes` is `pr`, `issue` or `null`, with the reasons in `notes`) and a numbered list of the user's changes.
- `xtend share <n>... --yes` ports those changes onto upstream and opens one draft PR or issue.

## Making a change yourself

You are the agent, so edit the code directly instead of running `xtend "<request>"`. Commit each change on its own, with a message that says what the user asked for and why: `git commit -m "xtend: <request>" -m "<what you changed and why>"`. Later merges rely on that message to keep the change working. Read `XTEND.md` or `.xtend/sheet.md` first. Prefer new files and small edits to files that upstream changes often.

## Giving back

- Run `xtend share --json` and show the user what upstream takes and what they could offer.
- Run `xtend share` with numbers and `--yes` only when the user asked, in this conversation, to offer those specific changes.
- Never pass `--signoff` for the user. A DCO sign-off is their legal statement, so ask them.
- If `takes` is `null`, tell the user why and stop. Do not open a PR or issue another way.
- Never touch `.git/config` or `.git/hooks`. xtend restores them and stops if they change.
