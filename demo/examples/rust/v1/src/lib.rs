use std::collections::BTreeMap;

#[derive(Debug, PartialEq)]
pub struct Entry {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Summary {
    pub counts: BTreeMap<String, usize>,
    pub errors: BTreeMap<String, usize>,
    pub skipped: usize,
}

/// Parses `<timestamp> <LEVEL> <message>`.
pub fn parse_line(line: &str) -> Option<Entry> {
    let mut parts = line.trim().splitn(3, ' ');
    let _time = parts.next()?;
    let level = parts.next()?;
    let message = parts.next()?;
    if !["ERROR", "WARN", "INFO", "DEBUG"].contains(&level) {
        return None;
    }
    Some(Entry { level: level.to_string(), message: message.to_string() })
}

pub fn summarize(text: &str) -> Summary {
    let mut s = Summary::default();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match parse_line(line) {
            Some(e) => {
                *s.counts.entry(e.level.clone()).or_insert(0) += 1;
                if e.level == "ERROR" {
                    *s.errors.entry(e.message).or_insert(0) += 1;
                }
            }
            None => s.skipped += 1,
        }
    }
    s
}

pub fn render(s: &Summary) -> String {
    let mut out = String::new();
    for (level, n) in &s.counts {
        out.push_str(&format!("{level}: {n}\n"));
    }
    if !s.errors.is_empty() {
        out.push_str("Errors:\n");
        let mut errs: Vec<_> = s.errors.iter().collect();
        errs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        for (msg, n) in errs {
            out.push_str(&format!("  {n}x {msg}\n"));
        }
    }
    if s.skipped > 0 {
        out.push_str(&format!("Skipped: {}\n", s.skipped));
    }
    out
}
