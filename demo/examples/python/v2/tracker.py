"""Habit tracker core, v2.

The store is {"version": 2, "habits": {name: {"done": {iso: note}, "freezes": [iso]}}}.
A frozen day keeps a streak alive without counting toward it.
"""
import json
import os
from datetime import timedelta

VERSION = 2


def migrate(raw):
    """Upgrade a v1 store (name -> list of dates) to the versioned layout."""
    if raw.get("version") == VERSION:
        return raw
    habits = {n: {"done": {d: "" for d in days}, "freezes": []} for n, days in raw.items()}
    return {"version": VERSION, "habits": habits}


def load(path):
    if not os.path.exists(path):
        return {"version": VERSION, "habits": {}}
    with open(path, encoding="utf-8") as f:
        return migrate(json.load(f))


def save(path, store):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2, sort_keys=True)


def _habit(store, name):
    if name not in store["habits"]:
        raise ValueError(f"no such habit: {name}")
    return store["habits"][name]


def add_habit(store, name):
    if name in store["habits"]:
        raise ValueError(f"habit exists: {name}")
    store["habits"][name] = {"done": {}, "freezes": []}


def log_done(store, name, day, note=""):
    habit = _habit(store, name)
    habit["done"].setdefault(day.isoformat(), note)
    if note:
        habit["done"][day.isoformat()] = note


def freeze(store, name, day):
    habit = _habit(store, name)
    iso = day.isoformat()
    if iso in habit["done"]:
        raise ValueError(f"already done on {iso}")
    if iso not in habit["freezes"]:
        habit["freezes"].append(iso)
        habit["freezes"].sort()


def current_streak(store, name, today):
    habit = _habit(store, name)
    done, frozen = habit["done"], set(habit["freezes"])
    cur = today
    if cur.isoformat() not in done and cur.isoformat() not in frozen:
        cur -= timedelta(days=1)
    count = 0
    while cur.isoformat() in done or cur.isoformat() in frozen:
        if cur.isoformat() in done:
            count += 1
        cur -= timedelta(days=1)
    return count


def render_report(store, today):
    lines = []
    for name in sorted(store["habits"]):
        n = current_streak(store, name, today)
        done = store["habits"][name]["done"]
        note = done[max(done)] if done else ""
        suffix = f" ({note})" if note else ""
        lines.append(f"{name}: {n} day streak{suffix}")
    return "\n".join(lines)
