use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const DOCKER_HOST_ERROR: &str = "[Agent CI] Error: DOCKER_HOST is no longer supported.\n  Rename it to AGENT_CI_DOCKER_HOST (shell env or .env.agent-ci).";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEnv {
    pub repo_root: PathBuf,
    pub agent_ci: BTreeMap<String, String>,
    pub docker_host: Option<String>,
}

pub fn bootstrap_env(
    start_dir: &Path,
    current_env: &BTreeMap<String, String>,
) -> Result<RuntimeEnv, String> {
    if current_env.contains_key("DOCKER_HOST") {
        return Err(DOCKER_HOST_ERROR.to_owned());
    }

    let repo_root = resolve_repo_root(start_dir);
    let env_file = repo_root.join(".env.agent-ci");
    let file_values = parse_env_file(&env_file)?;
    let agent_ci = effective_agent_ci_env(&file_values, current_env);
    let docker_host = agent_ci.get("AGENT_CI_DOCKER_HOST").cloned();

    Ok(RuntimeEnv {
        repo_root,
        agent_ci,
        docker_host,
    })
}

pub fn resolve_repo_root(start_dir: &Path) -> PathBuf {
    let original = start_dir.to_path_buf();
    let mut dir = original.clone();

    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return original;
        }
    }
}

pub fn parse_env_file(file_path: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    if !file_path.exists() {
        return Ok(result);
    }

    let content = fs::read_to_string(file_path)
        .map_err(|err| format!("failed to read {}: {err}", file_path.display()))?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(eq_index) = trimmed.find('=') else {
            continue;
        };
        if eq_index == 0 {
            continue;
        }

        let key = trimmed[..eq_index].trim();
        if key.is_empty() {
            continue;
        }

        let value = strip_wrapping_quotes(trimmed[eq_index + 1..].trim());
        result.insert(key.to_owned(), value.to_owned());
    }

    Ok(result)
}

pub fn load_machine_secrets(
    base_dir: &Path,
    env_fallback_keys: &[String],
    current_env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut secrets = parse_env_file(&base_dir.join(".env.agent-ci"))?;

    for key in env_fallback_keys {
        let should_fill = secrets.get(key).is_none_or(String::is_empty);
        if should_fill {
            if let Some(value) = current_env.get(key).filter(|value| !value.is_empty()) {
                secrets.insert(key.clone(), value.clone());
            }
        }
    }

    Ok(secrets)
}

fn effective_agent_ci_env(
    file_values: &BTreeMap<String, String>,
    current_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut result = current_env
        .iter()
        .filter(|(key, _)| key.starts_with("AGENT_CI_"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();

    for (key, value) in file_values {
        if key.starts_with("AGENT_CI_") && !result.contains_key(key) {
            result.insert(key.clone(), value.clone());
        }
    }

    result
}

fn strip_wrapping_quotes(value: &str) -> &str {
    let quoted_with_double = value.starts_with('"') && value.ends_with('"');
    let quoted_with_single = value.starts_with('\'') && value.ends_with('\'');
    if value.len() >= 2 && (quoted_with_double || quoted_with_single) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_env_agent_ci_syntax() {
        let dir = temp_dir("parse-env");
        let env_file = dir.join(".env.agent-ci");
        fs::write(
            &env_file,
            "\n# comment\nFOO=bar\nSPACED = value \nDOUBLE=\"quoted\"\nSINGLE='quoted too'\nNO_EQUALS\n=bad\n",
        )
        .unwrap();

        let parsed = parse_env_file(&env_file).unwrap();

        assert_eq!(parsed.get("FOO"), Some(&"bar".to_owned()));
        assert_eq!(parsed.get("SPACED"), Some(&"value".to_owned()));
        assert_eq!(parsed.get("DOUBLE"), Some(&"quoted".to_owned()));
        assert_eq!(parsed.get("SINGLE"), Some(&"quoted too".to_owned()));
        assert!(!parsed.contains_key("NO_EQUALS"));
    }

    #[test]
    fn applies_only_agent_ci_keys_and_preserves_shell_precedence() {
        let dir = temp_dir("bootstrap");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(
            dir.join(".env.agent-ci"),
            "AGENT_CI_DOCKER_HOST=unix:///file.sock\nAGENT_CI_JSON=1\nPLAIN_SECRET=secret\n",
        )
        .unwrap();
        let current_env = BTreeMap::from([(
            "AGENT_CI_DOCKER_HOST".to_owned(),
            "unix:///shell.sock".to_owned(),
        )]);

        let runtime = bootstrap_env(&dir, &current_env).unwrap();

        assert_eq!(runtime.repo_root, dir);
        assert_eq!(runtime.docker_host, Some("unix:///shell.sock".to_owned()));
        assert_eq!(
            runtime.agent_ci.get("AGENT_CI_DOCKER_HOST"),
            Some(&"unix:///shell.sock".to_owned())
        );
        assert_eq!(runtime.agent_ci.get("AGENT_CI_JSON"), Some(&"1".to_owned()));
        assert!(!runtime.agent_ci.contains_key("PLAIN_SECRET"));
    }

    #[test]
    fn rejects_shell_docker_host() {
        let dir = temp_dir("docker-host");
        let current_env = BTreeMap::from([(
            "DOCKER_HOST".to_owned(),
            "unix:///var/run/docker.sock".to_owned(),
        )]);

        let err = bootstrap_env(&dir, &current_env).unwrap_err();

        assert_eq!(err, DOCKER_HOST_ERROR);
    }

    #[test]
    fn loads_machine_secrets_with_env_fallbacks() {
        let dir = temp_dir("secrets");
        fs::write(dir.join(".env.agent-ci"), "TOKEN=file\nEMPTY=\n").unwrap();
        let env = BTreeMap::from([
            ("TOKEN".to_owned(), "shell".to_owned()),
            ("EMPTY".to_owned(), "fallback".to_owned()),
            ("OTHER".to_owned(), "other".to_owned()),
        ]);
        let keys = vec!["TOKEN".to_owned(), "EMPTY".to_owned(), "OTHER".to_owned()];

        let secrets = load_machine_secrets(&dir, &keys, &env).unwrap();

        assert_eq!(secrets.get("TOKEN"), Some(&"file".to_owned()));
        assert_eq!(secrets.get("EMPTY"), Some(&"fallback".to_owned()));
        assert_eq!(secrets.get("OTHER"), Some(&"other".to_owned()));
    }

    #[test]
    fn resolves_repo_root_by_walking_to_git_directory() {
        let dir = temp_dir("repo-root");
        let nested = dir.join("a/b/c");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(&nested).unwrap();

        assert_eq!(resolve_repo_root(&nested), dir);
    }
}
