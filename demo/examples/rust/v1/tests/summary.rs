use logsum::{parse_line, render, summarize};

const LOG: &str = "2026-10-27T10:00:01 INFO started
2026-10-27T10:00:02 ERROR disk full
2026-10-27T10:00:03 WARN slow query
2026-10-27T10:00:04 ERROR disk full
2026-10-27T10:00:05 ERROR timeout
garbage
";

#[test]
fn parses_a_line() {
    let e = parse_line("2026-10-27T10:00:01 WARN low memory").unwrap();
    assert_eq!(e.level, "WARN");
    assert_eq!(e.message, "low memory");
}

#[test]
fn rejects_unknown_levels() {
    assert!(parse_line("2026-10-27T10:00:01 LOUD hi").is_none());
    assert!(parse_line("nonsense").is_none());
}

#[test]
fn counts_levels_and_skips_garbage() {
    let s = summarize(LOG);
    assert_eq!(s.counts["ERROR"], 3);
    assert_eq!(s.counts["INFO"], 1);
    assert_eq!(s.skipped, 1);
}

#[test]
fn render_lists_common_errors_first() {
    let out = render(&summarize(LOG));
    assert!(out.contains("ERROR: 3\n"));
    assert!(out.contains("Errors:\n  2x disk full\n  1x timeout\n"));
    assert!(out.ends_with("Skipped: 1\n"));
}
