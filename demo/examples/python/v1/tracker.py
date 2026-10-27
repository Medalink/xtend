"""Habit tracker core. The store maps habit name -> sorted list of ISO dates."""
import json
import os
from datetime import timedelta


def load(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, store):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2, sort_keys=True)


def add_habit(store, name):
    if name in store:
        raise ValueError(f"habit exists: {name}")
    store[name] = []


def check_in(store, name, day):
    if name not in store:
        raise ValueError(f"no such habit: {name}")
    iso = day.isoformat()
    if iso not in store[name]:
        store[name].append(iso)
        store[name].sort()


def streak(store, name, today):
    days = set(store[name])
    cur = today if today.isoformat() in days else today - timedelta(days=1)
    count = 0
    while cur.isoformat() in days:
        count += 1
        cur -= timedelta(days=1)
    return count


def report(store, today):
    lines = []
    for name in sorted(store):
        n = streak(store, name, today)
        lines.append(f"{name}: {n} day streak")
    return "\n".join(lines)
