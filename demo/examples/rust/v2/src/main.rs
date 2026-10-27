use logsum::Level;
use std::io::Read;

fn main() {
    let mut min = Level::Debug;
    let mut path = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--min-level" {
            let v = args.next().unwrap_or_default();
            min = v.parse().unwrap_or_else(|_| {
                eprintln!("logsum: unknown level {v:?}");
                std::process::exit(2);
            });
        } else {
            path = Some(a);
        }
    }
    let text = match path {
        Some(p) => std::fs::read_to_string(&p).unwrap_or_else(|e| {
            eprintln!("logsum: {p}: {e}");
            std::process::exit(1);
        }),
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).expect("read stdin");
            buf
        }
    };
    let summary = logsum::summarize(&text, min);
    print!("{}", logsum::render(&summary, min));
}
