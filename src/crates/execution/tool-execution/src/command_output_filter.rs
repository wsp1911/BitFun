//! Deterministic, fail-open filtering for completed shell output.
//!
//! The command tool keeps the canonical result untouched. This module only
//! produces a smaller assistant-facing projection for a deliberately small
//! allowlist of repetitive commands. It never starts a process, reads config,
//! or performs network/model calls.

#[derive(Debug, Clone, Copy)]
pub struct CommandOutputFilterInput<'a> {
    pub command: &'a str,
    pub output: &'a str,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutputFilterResult {
    pub output: String,
    pub changed: bool,
    pub original_chars: usize,
    pub filtered_chars: usize,
    pub rule_id: Option<&'static str>,
}

/// Apply the deterministic command-output policy.
///
/// `None` means that the command is outside the policy, the process is still
/// running, or no strictly smaller safe projection was produced.
#[cfg(feature = "command-output-filter")]
pub fn filter(input: CommandOutputFilterInput<'_>) -> Option<CommandOutputFilterResult> {
    if input.timed_out
        || input.exit_code.is_none()
        || input.output.is_empty()
        || !is_supported_command(input.command)
    {
        return None;
    }

    let original_chars = input.output.chars().count();
    let clean = strip_ansi(input.output);
    let mut candidate = clean.clone();
    let mut rule_id = if clean != input.output {
        Some("ansi-strip")
    } else {
        None
    };

    if let Some(compressed) = lean_ctx_patterns::compress_clean(
        &lean_ctx_patterns::NoEnv,
        input.command,
        &clean,
        input.output,
    ) {
        if compressed.chars().count() < candidate.chars().count() {
            candidate = compressed;
            rule_id = Some("lean-ctx-pattern")
        }
    }

    let filtered_chars = candidate.chars().count();
    if filtered_chars >= original_chars || candidate == input.output {
        return None;
    }

    Some(CommandOutputFilterResult {
        output: candidate,
        changed: true,
        original_chars,
        filtered_chars,
        rule_id,
    })
}

#[cfg(not(feature = "command-output-filter"))]
pub fn filter(_input: CommandOutputFilterInput<'_>) -> Option<CommandOutputFilterResult> {
    None
}

/// The first version intentionally recognizes only commands with stable,
/// line-oriented output. Unknown commands and arbitrary shell pipelines pass
/// through unchanged so a heuristic cannot hide task-specific data.
pub fn is_supported_command(command: &str) -> bool {
    let command = command.trim();
    let command = command
        .strip_prefix("cd ")
        .and_then(|value| value.split_once("&&").map(|(_, rest)| rest.trim()))
        .unwrap_or(command);
    if ["&&", "||", ";", "|"]
        .iter()
        .any(|operator| command.contains(operator))
    {
        return false;
    }
    let command = command.strip_prefix("command ").unwrap_or(command);
    let mut parts = command.split_whitespace();
    let executable = parts.next().unwrap_or_default().to_ascii_lowercase();
    let subcommand = parts.next().unwrap_or_default().to_ascii_lowercase();

    match executable.as_str() {
        "git" => {
            matches!(subcommand.as_str(), "status" | "log" | "diff")
                && (subcommand != "diff"
                    || command.contains(" --stat")
                    || command.contains(" --name-only")
                    || command.contains(" --numstat"))
        }
        "cargo" => matches!(subcommand.as_str(), "check" | "build" | "test" | "clippy"),
        "npm" | "pnpm" | "yarn" => {
            matches!(subcommand.as_str(), "install" | "i" | "build" | "test")
        }
        "pytest" => true,
        "docker" => matches!(subcommand.as_str(), "ps" | "images" | "logs"),
        "kubectl" | "k" => matches!(subcommand.as_str(), "get" | "logs" | "describe"),
        _ => false,
    }
}

#[cfg(feature = "command-output-filter")]
fn strip_ansi(output: &str) -> String {
    lean_ctx_patterns::ansi::strip_ansi(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "command-output-filter")]
    #[test]
    fn unknown_commands_are_passthrough() {
        assert!(!is_supported_command("cat package.json"));
        assert!(filter(CommandOutputFilterInput {
            command: "cat package.json",
            output: "value\nvalue\n",
            exit_code: Some(0),
            timed_out: false,
        })
        .is_none());
    }

    #[cfg(feature = "command-output-filter")]
    #[test]
    fn ansi_is_removed_only_for_supported_commands() {
        let result = filter(CommandOutputFilterInput {
            command: "git status --short",
            output: "\x1b[32m M src/main.rs\x1b[0m\n",
            exit_code: Some(0),
            timed_out: false,
        })
        .expect("ANSI output should have a smaller projection");
        assert!(result.output.contains("M src/main.rs"));
        assert!(result.changed);
        assert!(result.filtered_chars < result.original_chars);
    }

    #[cfg(not(feature = "command-output-filter"))]
    #[test]
    fn disabled_feature_is_fail_open() {
        assert!(filter(CommandOutputFilterInput {
            command: "git status --short",
            output: "\x1b[32m M src/main.rs\x1b[0m\n",
            exit_code: Some(0),
            timed_out: false,
        })
        .is_none());
    }

    #[test]
    fn running_or_timed_out_commands_are_passthrough() {
        for input in [
            CommandOutputFilterInput {
                command: "cargo test",
                output: "running 1 test\n",
                exit_code: None,
                timed_out: false,
            },
            CommandOutputFilterInput {
                command: "cargo test",
                output: "running 1 test\n",
                exit_code: None,
                timed_out: true,
            },
        ] {
            assert!(filter(input).is_none());
        }
    }
}
