use logsum::{parse_entry, render, summarize, Level};

const LOG: &str = "2026-10-27T10:00:01 INFO started
2026-10-27T10:20:02 error disk full
2026-10-27T11:00:03 WARNING slow query
2026-10-27T11:00:04 ERROR disk full
2026-10-27T11:00:05 ERROR timeout
garbage
";

#[test]
fn parses_an_entry_with_hour() {
    let e = parse_entry("2026-10-27T10:30:01 warn low memory").unwrap();
    assert_eq!(e.level, Level::Warn);
    assert_eq!(e.hour, "2026-10-27T10");
    assert_eq!(e.message, "low memory");
}

#[test]
fn rejects_unknown_levels_and_bad_times() {
    assert!(parse_entry("2026-10-27T10:00:01 LOUD hi").is_none());
    assert!(parse_entry("yesterday ERROR hi").is_none());
}

#[test]
fn levels_are_ordered() {
    assert!(Level::Error > Level::Warn && Level::Warn > Level::Info && Level::Info > Level::Debug);
}

#[test]
fn buckets_by_hour() {
    let s = summarize(LOG, Level::Debug);
    assert_eq!(s.by_hour["2026-10-27T10"], 2);
    assert_eq!(s.by_hour["2026-10-27T11"], 3);
    assert_eq!(s.skipped, 1);
}

#[test]
fn min_level_filters_entries() {
    let s = summarize(LOG, Level::Warn);
    assert_eq!(s.by_level.len(), 2);
    assert!(!s.by_level.contains_key(&Level::Info));
}

#[test]
fn render_lists_worst_first() {
    let out = render(&summarize(LOG, Level::Debug), Level::Debug);
    assert!(out.starts_with("ERROR: 3\nWARN: 1\nINFO: 1\n"));
    assert!(out.contains("Top errors:\n  2x disk full\n  1x timeout\n"));
    assert!(out.ends_with("Total: 5\nSkipped: 1 unparsable\n"));
}

#[test]
fn render_announces_the_filter() {
    let out = render(&summarize(LOG, Level::Warn), Level::Warn);
    assert!(out.starts_with("Showing WARN and above\nERROR: 3\n"));
    assert!(out.contains("Total: 4\n"));
}
