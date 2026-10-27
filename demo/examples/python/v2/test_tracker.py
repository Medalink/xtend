import io
import os
import tempfile
import unittest
from datetime import date

import cli
import tracker

D = date(2026, 3, 10)


def day(n):
    return date(2026, 3, n)


def fresh(*names):
    store = {"version": 2, "habits": {}}
    for n in names:
        tracker.add_habit(store, n)
    return store


class TrackerTests(unittest.TestCase):
    def test_add_and_duplicate(self):
        store = fresh("run")
        self.assertEqual(store["habits"]["run"], {"done": {}, "freezes": []})
        with self.assertRaises(ValueError):
            tracker.add_habit(store, "run")

    def test_log_done_keeps_note(self):
        store = fresh("run")
        tracker.log_done(store, "run", day(9))
        tracker.log_done(store, "run", day(9), "5k")
        tracker.log_done(store, "run", day(9))
        self.assertEqual(store["habits"]["run"]["done"], {"2026-03-09": "5k"})

    def test_unknown_habit(self):
        with self.assertRaises(ValueError):
            tracker.log_done(fresh(), "nope", D)

    def test_streak(self):
        store = fresh("run")
        for n in (7, 9, 10):
            tracker.log_done(store, "run", day(n))
        self.assertEqual(tracker.current_streak(store, "run", D), 2)
        self.assertEqual(tracker.current_streak(store, "run", day(12)), 0)

    def test_freeze_bridges_gap_without_counting(self):
        store = fresh("run")
        for n in (7, 9, 10):
            tracker.log_done(store, "run", day(n))
        tracker.freeze(store, "run", day(8))
        self.assertEqual(tracker.current_streak(store, "run", D), 3)
        with self.assertRaises(ValueError):
            tracker.freeze(store, "run", day(9))

    def test_migrate_v1_store(self):
        store = tracker.migrate({"run": ["2026-03-09", "2026-03-10"]})
        self.assertEqual(store["version"], 2)
        self.assertEqual(tracker.current_streak(store, "run", D), 2)
        self.assertIs(tracker.migrate(store), store)

    def test_report_shows_latest_note(self):
        store = fresh("b", "a")
        tracker.log_done(store, "b", D, "leg day")
        self.assertEqual(tracker.render_report(store, D), "a: 0 day streak\nb: 1 day streak (leg day)")

    def test_cli_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "h.json")
            out = io.StringIO()
            self.assertEqual(cli.main(["add", "run"], path, D, out), 0)
            self.assertEqual(cli.main(["freeze", "run"], path, day(9), out), 0)
            self.assertEqual(cli.main(["done", "run", "easy", "pace"], path, D, out), 0)
            self.assertEqual(cli.main(["report"], path, D, out), 0)
            self.assertIn("run: 1 day streak (easy pace)", out.getvalue())
            self.assertEqual(cli.main(["done", "nope"], path, D, out), 1)


if __name__ == "__main__":
    unittest.main()
