//! Environment files: `KEY=VALUE` lines, `#` comments, optional `export `
//! prefix, single quotes (literal) and double quotes (`\n \" \\` escapes).

use std::collections::BTreeMap;

pub fn parse(text: &str) -> (BTreeMap<String, String>, Vec<String>) {
    let mut vals = BTreeMap::new();
    let mut order = Vec::new();
    for line in text.lines() {
        if let Some((k, v)) = parse_line(line) {
            if !vals.contains_key(&k) {
                order.push(k.clone());
            }
            vals.insert(k, v);
        }
    }
    (vals, order)
}

fn parse_line(line: &str) -> Option<(String, String)> {
    let s = line.trim();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    let s = s.strip_prefix("export ").unwrap_or(s);
    let (k, v) = s.split_once('=')?;
    let key = k.trim();
    if key.is_empty() {
        return None;
    }
    let v = v.trim();
    let val = if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        unescape(&v[1..v.len() - 1])
    } else if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        v[1..v.len() - 1].to_string()
    } else {
        match v.find(" #") {
            Some(i) => v[..i].trim().to_string(),
            None => v.to_string(),
        }
    };
    Some((key.to_string(), val))
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn format_value(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    if v.contains(['"', '\'', '#', '\\', '\n', '\r', '\t']) || v.trim() != v {
        let e = v
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t");
        return format!("\"{e}\"");
    }
    v.to_string()
}

/// Applies changes (None = remove) while keeping comments, ordering and
/// untouched lines intact. New keys are appended in `order`.
pub fn update(text: &str, changes: &BTreeMap<String, Option<String>>, order: &[String]) -> String {
    let mut done = std::collections::BTreeSet::new();
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if let Some((k, _)) = parse_line(line) {
            if let Some(v) = changes.get(&k) {
                if done.contains(&k) {
                    continue;
                }
                done.insert(k.clone());
                if let Some(v) = v {
                    out.push(format!("{k}={}", format_value(v)));
                }
                continue;
            }
        }
        out.push(line.to_string());
    }
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    let rest = order.iter().chain(changes.keys());
    for k in rest {
        if done.contains(k) {
            continue;
        }
        if let Some(Some(v)) = changes.get(k) {
            done.insert(k.clone());
            out.push(format!("{k}={}", format_value(v)));
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let text = "# comment\nexport A=1\nB=\"x\\ny\"\nC='lit # x'\nD=val # trailing\n";
        let (v, order) = parse(text);
        assert_eq!(v["A"], "1");
        assert_eq!(v["B"], "x\ny");
        assert_eq!(v["C"], "lit # x");
        assert_eq!(v["D"], "val");
        assert_eq!(order, vec!["A", "B", "C", "D"]);

        let mut ch = BTreeMap::new();
        ch.insert("A".to_string(), Some("2".to_string()));
        ch.insert("C".to_string(), None);
        ch.insert("E".to_string(), Some("a b ".to_string()));
        let out = update(text, &ch, &["E".to_string()]);
        assert_eq!(out, "# comment\nA=2\nB=\"x\\ny\"\nD=val # trailing\nE=\"a b \"\n");
        assert_eq!(parse(&out).0["E"], "a b ");
    }
}
