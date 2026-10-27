use std::collections::BTreeMap;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl FromStr for Level {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s.to_ascii_uppercase().as_str() {
            "DEBUG" => Ok(Level::Debug),
            "INFO" => Ok(Level::Info),
            "WARN" | "WARNING" => Ok(Level::Warn),
            "ERROR" => Ok(Level::Error),
            _ => Err(()),
        }
    }
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Entry {
    pub hour: String,
    pub level: Level,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct Summary {
    pub by_level: BTreeMap<Level, usize>,
    pub by_hour: BTreeMap<String, usize>,
    pub top_errors: BTreeMap<String, usize>,
    pub skipped: usize,
}

/// Parses `<YYYY-MM-DDTHH:MM:SS> <LEVEL> <message>`; levels are case-insensitive.
pub fn parse_entry(line: &str) -> Option<Entry> {
    let mut parts = line.trim().splitn(3, ' ');
    let time = parts.next()?;
    let level = parts.next()?.parse().ok()?;
    let message = parts.next()?.to_string();
    let hour = time.get(..13).filter(|h| h.as_bytes().get(10) == Some(&b'T'))?;
    Some(Entry { hour: hour.to_string(), level, message })
}

pub fn summarize(text: &str, min: Level) -> Summary {
    let mut s = Summary::default();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match parse_entry(line) {
            Some(e) if e.level >= min => {
                *s.by_level.entry(e.level).or_insert(0) += 1;
                *s.by_hour.entry(e.hour).or_insert(0) += 1;
                if e.level == Level::Error {
                    *s.top_errors.entry(e.message).or_insert(0) += 1;
                }
            }
            Some(_) => {}
            None => s.skipped += 1,
        }
    }
    s
}

pub fn render(s: &Summary, min: Level) -> String {
    let mut out = String::new();
    if min > Level::Debug {
        out.push_str(&format!("Showing {} and above\n", min.name()));
    }
    for (level, n) in s.by_level.iter().rev() {
        out.push_str(&format!("{}: {n}\n", level.name()));
    }
    if !s.by_hour.is_empty() {
        out.push_str("Per hour:\n");
        for (hour, n) in &s.by_hour {
            out.push_str(&format!("  {hour}h {n}\n"));
        }
    }
    if !s.top_errors.is_empty() {
        out.push_str("Top errors:\n");
        let mut errs: Vec<_> = s.top_errors.iter().collect();
        errs.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        for (msg, n) in errs.into_iter().take(3) {
            out.push_str(&format!("  {n}x {msg}\n"));
        }
    }
    let total: usize = s.by_level.values().sum();
    out.push_str(&format!("Total: {total}\n"));
    if s.skipped > 0 {
        out.push_str(&format!("Skipped: {} unparsable\n", s.skipped));
    }
    out
}
