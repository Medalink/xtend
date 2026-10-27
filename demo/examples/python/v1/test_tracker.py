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


class TrackerTests(unittest.TestCase):
    def test_add_and_duplicate(self):
        store = {}
        tracker.add_habit(store, "run")
        self.assertEqual(store, {"run": []})
        with self.assertRaises(ValueError):
            tracker.add_habit(store, "run")

    def test_check_in_is_idempotent_and_sorted(self):
        store = {"run": []}
        tracker.check_in(store, "run", day(9))
        tracker.check_in(store, "run", day(8))
        tracker.check_in(store, "run", day(9))
        self.assertEqual(store["run"], ["2026-03-08", "2026-03-09"])

    def test_unknown_habit(self):
        with self.assertRaises(ValueError):
            tracker.check_in({}, "nope", D)

    def test_streak(self):
        store = {"run": ["2026-03-07", "2026-03-09", "2026-03-10"]}
        self.assertEqual(tracker.streak(store, "run", D), 2)
        self.assertEqual(tracker.streak(store, "run", day(11)), 2)
        self.assertEqual(tracker.streak(store, "run", day(12)), 0)

    def test_report(self):
        store = {"b": ["2026-03-10"], "a": []}
        self.assertEqual(tracker.report(store, D), "a: 0 day streak\nb: 1 day streak")

    def test_cli_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "h.json")
            out = io.StringIO()
            self.assertEqual(cli.main(["add", "run"], path, D, out), 0)
            self.assertEqual(cli.main(["done", "run"], path, D, out), 0)
            self.assertEqual(cli.main(["report"], path, D, out), 0)
            self.assertIn("run: 1 day streak", out.getvalue())
            self.assertEqual(cli.main(["done", "nope"], path, D, out), 1)


if __name__ == "__main__":
    unittest.main()
