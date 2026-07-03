//! Helpers for parsing the interactive `gh auth login --web` output.
//!
//! The device flow prints a one-time code like `ABCD-1234`; we scan gh's output
//! for it (stdout or stderr, wording varies by version) rather than depending on
//! an exact line format. Deliberately dependency-free — no regex crate.

/// Extract a `XXXX-XXXX` device code from a line of gh output, if present.
/// A device code is two 4-char groups of uppercase letters/digits joined by `-`.
pub fn extract_device_code(line: &str) -> Option<String> {
    // Split on whitespace and punctuation that can't appear inside a code.
    for token in line.split(|c: char| c.is_whitespace() || c == '.' || c == ',' || c == ':') {
        let token = token.trim();
        if is_device_code(token) {
            return Some(token.to_string());
        }
    }
    None
}

fn is_device_code(s: &str) -> bool {
    let (a, b) = match s.split_once('-') {
        Some(parts) => parts,
        None => return false,
    };
    a.len() == 4
        && b.len() == 4
        && [a, b].iter().all(|part| part.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_code_in_gh_prompt() {
        assert_eq!(extract_device_code("! First copy your one-time code: ABCD-1234"), Some("ABCD-1234".into()));
        assert_eq!(extract_device_code("code is 8WZ2-QK9P."), Some("8WZ2-QK9P".into()));
    }

    #[test]
    fn ignores_non_codes() {
        assert_eq!(extract_device_code("Press Enter to open github.com in your browser..."), None);
        assert_eq!(extract_device_code("no code here"), None);
        assert_eq!(extract_device_code("abcd-1234"), None); // lowercase isn't a device code
        assert_eq!(extract_device_code("ABC-12345"), None); // wrong grouping
    }
}
