"""Usage: python cli.py add NAME | done NAME | report"""
import os
import sys
from datetime import date

import tracker

DEFAULT_PATH = os.environ.get("HABITS_FILE", "habits.json")


def main(argv, path=DEFAULT_PATH, today=None, out=sys.stdout):
    today = today or date.today()
    store = tracker.load(path)
    cmd, args = (argv[0] if argv else "report"), argv[1:]
    try:
        if cmd == "add":
            tracker.add_habit(store, args[0])
        elif cmd == "done":
            tracker.check_in(store, args[0], today)
        elif cmd == "report":
            print(tracker.report(store, today), file=out)
            return 0
        else:
            print(__doc__, file=out)
            return 2
    except (ValueError, IndexError) as e:
        print(f"error: {e or 'missing habit name'}", file=out)
        return 1
    tracker.save(path, store)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
