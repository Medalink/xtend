use std::io::Read;

fn main() {
    let text = match std::env::args().nth(1) {
        Some(path) => std::fs::read_to_string(&path).unwrap_or_else(|e| {
            eprintln!("logsum: {path}: {e}");
            std::process::exit(1);
        }),
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).expect("read stdin");
            buf
        }
    };
    let summary = logsum::summarize(&text);
    print!("{}", logsum::render(&summary));
}
