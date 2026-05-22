use globset::Glob;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpressionContext {
    pub repo_path: Option<PathBuf>,
    pub secrets: BTreeMap<String, String>,
    pub matrix: BTreeMap<String, String>,
    pub needs: BTreeMap<String, BTreeMap<String, String>>,
    pub inputs: BTreeMap<String, String>,
    pub vars: BTreeMap<String, String>,
    pub runner: RunnerContext,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerContext {
    pub os: String,
    pub arch: String,
}

impl Default for RunnerContext {
    fn default() -> Self {
        Self {
            os: "Linux".to_owned(),
            arch: "X64".to_owned(),
        }
    }
}

pub fn expand_expressions(value: &str, context: &ExpressionContext) -> String {
    let mut output = String::new();
    let mut rest = value;

    while let Some(start) = rest.find("${{") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 3..];
        let Some(end) = after_start.find("}}") else {
            output.push_str(&rest[start..]);
            return output;
        };
        let expression = &after_start[..end];
        output.push_str(&evaluate_expr_value(expression, context));
        rest = &after_start[end + 2..];
    }

    output.push_str(rest);
    output
}

pub fn evaluate_job_if(
    expression: &str,
    job_results: &BTreeMap<String, String>,
    needs: &BTreeMap<String, BTreeMap<String, String>>,
) -> bool {
    let mut context = ExpressionContext {
        needs: needs.clone(),
        ..ExpressionContext::default()
    };
    context.env.insert(
        "__all_success".to_owned(),
        job_results
            .values()
            .all(|result| result == "success")
            .to_string(),
    );
    context.env.insert(
        "__any_failure".to_owned(),
        job_results
            .values()
            .any(|result| result == "failure")
            .to_string(),
    );

    is_truthy(&evaluate_expr_value(expression, &context))
}

pub fn evaluate_expr_value(expression: &str, context: &ExpressionContext) -> String {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(stripped) = strip_outer_parens(trimmed) {
        return evaluate_expr_value(stripped, context);
    }

    let or_parts = split_on_operator(trimmed, "||");
    if or_parts.len() > 1 {
        let mut last = String::new();
        for part in or_parts {
            last = evaluate_expr_value(part.trim(), context);
            if is_truthy(&last) {
                return last;
            }
        }
        return last;
    }

    let and_parts = split_on_operator(trimmed, "&&");
    if and_parts.len() > 1 {
        let mut last = String::new();
        for part in and_parts {
            last = evaluate_expr_value(part.trim(), context);
            if !is_truthy(&last) {
                return last;
            }
        }
        return last;
    }

    for op in ["!=", "==", "<=", ">=", "<", ">"] {
        let parts = split_on_operator(trimmed, op);
        if parts.len() == 2 {
            return compare_values(
                &evaluate_expr_value(parts[0].trim(), context),
                &evaluate_expr_value(parts[1].trim(), context),
                op,
            )
            .to_string();
        }
    }

    if let Some(inner) = trimmed.strip_prefix('!') {
        return (!is_truthy(&evaluate_expr_value(inner.trim(), context))).to_string();
    }

    if is_quoted(trimmed) {
        return unquote(trimmed).to_owned();
    }

    match trimmed {
        "true" => return "true".to_owned(),
        "false" => return "false".to_owned(),
        "null" => return String::new(),
        "success()" => {
            return context
                .env
                .get("__all_success")
                .cloned()
                .unwrap_or_else(|| "true".to_owned());
        }
        "failure()" => {
            return context
                .env
                .get("__any_failure")
                .cloned()
                .unwrap_or_else(|| "false".to_owned());
        }
        "always()" => return "true".to_owned(),
        "cancelled()" => return "false".to_owned(),
        _ => {}
    }

    if trimmed.parse::<f64>().is_ok() {
        return trimmed.to_owned();
    }

    if let Some((name, raw_args)) = parse_function_call(trimmed) {
        return evaluate_function(name, raw_args, context);
    }

    resolve_context_ref(trimmed, context).unwrap_or_default()
}

fn evaluate_function(name: &str, raw_args: &str, context: &ExpressionContext) -> String {
    match name {
        "contains" => eval_contains(raw_args, context),
        "startsWith" => eval_starts_with(raw_args, context),
        "endsWith" => eval_ends_with(raw_args, context),
        "fromJSON" => eval_from_json(raw_args, context),
        "toJSON" => eval_to_json(raw_args, context),
        "format" => eval_format(raw_args, context),
        "join" => eval_join(raw_args, context),
        "hashFiles" => eval_hash_files(raw_args, context),
        _ => String::new(),
    }
}

fn eval_contains(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    let haystack = evaluate_expr_value(&args[0], context);
    let needle = evaluate_expr_value(&args[1], context).to_lowercase();
    if let Ok(JsonValue::Array(items)) = serde_json::from_str::<JsonValue>(&haystack) {
        return items
            .iter()
            .any(|item| json_value_to_string(item).to_lowercase() == needle)
            .to_string();
    }
    haystack.to_lowercase().contains(&needle).to_string()
}

fn eval_starts_with(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    evaluate_expr_value(&args[0], context)
        .to_lowercase()
        .starts_with(&evaluate_expr_value(&args[1], context).to_lowercase())
        .to_string()
}

fn eval_ends_with(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    if args.len() < 2 {
        return "false".to_owned();
    }
    evaluate_expr_value(&args[0], context)
        .to_lowercase()
        .ends_with(&evaluate_expr_value(&args[1], context).to_lowercase())
        .to_string()
}

fn eval_from_json(raw_args: &str, context: &ExpressionContext) -> String {
    let raw_value = eval_arg_or_literal(raw_args, context);
    serde_json::from_str::<JsonValue>(&raw_value).map_or_else(
        |_| String::new(),
        |parsed| match parsed {
            JsonValue::String(value) => value,
            other => serde_json::to_string(&other).unwrap_or_default(),
        },
    )
}

fn eval_to_json(raw_args: &str, context: &ExpressionContext) -> String {
    let raw_value = eval_arg_or_literal(raw_args, context);
    serde_json::from_str::<JsonValue>(&raw_value).map_or_else(
        |_| serde_json::to_string_pretty(&raw_value).unwrap_or_default(),
        |parsed| serde_json::to_string_pretty(&parsed).unwrap_or_default(),
    )
}

fn eval_format(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    let template = args.first().map_or("", |arg| unquote(arg.trim()));
    let values = args
        .iter()
        .skip(1)
        .map(|arg| evaluate_expr_value(arg, context))
        .collect::<Vec<_>>();
    let mut output = template.to_owned();
    for (index, value) in values.iter().enumerate() {
        output = output.replace(&format!("{{{index}}}"), value);
    }
    output
}

fn eval_join(raw_args: &str, context: &ExpressionContext) -> String {
    let args = split_function_args(raw_args);
    let value = args
        .first()
        .map_or_else(String::new, |arg| evaluate_expr_value(arg, context));
    let separator = args
        .get(1)
        .map_or_else(|| ", ".to_owned(), |arg| evaluate_expr_value(arg, context));
    if let Ok(JsonValue::Array(items)) = serde_json::from_str::<JsonValue>(&value) {
        return items
            .iter()
            .map(json_value_to_string)
            .collect::<Vec<_>>()
            .join(&separator);
    }
    value
}

fn eval_hash_files(raw_args: &str, context: &ExpressionContext) -> String {
    let Some(repo_path) = context.repo_path.as_deref() else {
        return ZERO_SHA.to_owned();
    };
    let patterns = split_function_args(raw_args)
        .into_iter()
        .map(|arg| evaluate_expr_value(&arg, context))
        .collect::<Vec<_>>();
    hash_files(repo_path, &patterns)
}

pub fn hash_files(repo_path: &Path, patterns: &[String]) -> String {
    let mut included = BTreeSet::new();
    for pattern in patterns {
        if let Some(negative) = pattern.strip_prefix('!') {
            for file in find_files(repo_path, negative) {
                included.remove(&file);
            }
        } else {
            included.extend(find_files(repo_path, pattern));
        }
    }

    if included.is_empty() {
        return ZERO_SHA.to_owned();
    }

    let mut hasher = Sha256::new();
    for file in included {
        if let Ok(bytes) = fs::read(file) {
            hasher.update(bytes);
        }
    }
    format!("{:x}", hasher.finalize())
}

fn find_files(root_dir: &Path, pattern: &str) -> BTreeSet<PathBuf> {
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let matcher = Glob::new(pattern).ok().map(|glob| glob.compile_matcher());
    let mut results = BTreeSet::new();
    walk_files(root_dir, Path::new(""), matcher.as_ref(), &mut results);
    results
}

fn walk_files(
    root_dir: &Path,
    relative: &Path,
    matcher: Option<&globset::GlobMatcher>,
    results: &mut BTreeSet<PathBuf>,
) {
    let dir = root_dir.join(relative);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if name == "node_modules" {
            continue;
        }
        let relative_child = relative.join(&name);
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            walk_files(root_dir, &relative_child, matcher, results);
        } else if matcher.is_some_and(|matcher| matcher.is_match(&relative_child)) {
            results.insert(root_dir.join(relative_child));
        }
    }
}

fn resolve_context_ref(trimmed: &str, context: &ExpressionContext) -> Option<String> {
    match trimmed {
        "runner.os" => return Some(context.runner.os.clone()),
        "runner.arch" => return Some(context.runner.arch.clone()),
        "strategy.job-total" => {
            return Some(
                context
                    .matrix
                    .get("__job_total")
                    .cloned()
                    .unwrap_or_else(|| "1".to_owned()),
            );
        }
        "strategy.job-index" => {
            return Some(
                context
                    .matrix
                    .get("__job_index")
                    .cloned()
                    .unwrap_or_else(|| "0".to_owned()),
            );
        }
        "github.run_id" | "github.run_number" => return Some("1".to_owned()),
        "github.sha" | "github.head_sha" => return Some(ZERO_SHA.to_owned()),
        "github.ref_name" | "github.head_ref" => return Some("main".to_owned()),
        "github.repository" => return Some("local/repo".to_owned()),
        "github.actor" => return Some("local".to_owned()),
        "github.event.pull_request.number"
        | "github.event.pull_request.title"
        | "github.event.pull_request.user.login" => return Some(String::new()),
        "github.event.pull_request.draft" => return Some("false".to_owned()),
        "github.event.pull_request.author_association" => return Some("OWNER".to_owned()),
        "github.event.pull_request.labels.*.name" => return Some("[]".to_owned()),
        _ => {}
    }

    for (prefix, values) in [
        ("matrix.", &context.matrix),
        ("secrets.", &context.secrets),
        ("vars.", &context.vars),
        ("inputs.", &context.inputs),
        ("env.", &context.env),
    ] {
        if let Some(key) = trimmed.strip_prefix(prefix) {
            return Some(values.get(key).cloned().unwrap_or_default());
        }
    }

    if trimmed.starts_with("steps.") {
        return Some(String::new());
    }
    if trimmed.starts_with("needs.") {
        return Some(resolve_needs_ref(trimmed, &context.needs));
    }
    None
}

fn resolve_needs_ref(trimmed: &str, needs: &BTreeMap<String, BTreeMap<String, String>>) -> String {
    let parts = trimmed.split('.').collect::<Vec<_>>();
    let Some(job_outputs) = parts.get(1).and_then(|job| needs.get(*job)) else {
        return String::new();
    };
    match (parts.get(2), parts.get(3)) {
        (Some(&"outputs"), Some(name)) => job_outputs.get(*name).cloned().unwrap_or_default(),
        (Some(&"result"), _) => job_outputs
            .get("__result")
            .cloned()
            .unwrap_or_else(|| "success".to_owned()),
        _ => String::new(),
    }
}

fn eval_arg_or_literal(inner: &str, context: &ExpressionContext) -> String {
    let trimmed = inner.trim();
    if is_quoted(trimmed) {
        unquote(trimmed).to_owned()
    } else {
        evaluate_expr_value(trimmed, context)
    }
}

fn split_function_args(args: &str) -> Vec<String> {
    split_top_level(args, ",")
        .into_iter()
        .map(|part| part.trim().to_owned())
        .collect()
}

fn split_on_operator(expression: &str, operator: &str) -> Vec<String> {
    split_top_level(expression, operator)
}

fn split_top_level(expression: &str, operator: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0_i32;
    let mut quote = None;
    let chars = expression.char_indices().collect::<Vec<_>>();
    let mut index = 0;

    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if let Some(active_quote) = quote {
            current.push(ch);
            if ch == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            index += 1;
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth == 0 && expression[byte_index..].starts_with(operator) {
            parts.push(current);
            current = String::new();
            index += operator.chars().count();
            continue;
        }
        current.push(ch);
        index += 1;
    }
    parts.push(current);
    parts
}

fn strip_outer_parens(trimmed: &str) -> Option<&str> {
    if !trimmed.starts_with('(') {
        return None;
    }
    let mut depth = 0_i32;
    let mut quote = None;
    for (index, ch) in trimmed.char_indices() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return (index == trimmed.len() - 1).then(|| &trimmed[1..trimmed.len() - 1]);
        }
    }
    None
}

fn parse_function_call(trimmed: &str) -> Option<(&str, &str)> {
    let open = trimmed.find('(')?;
    if !trimmed.ends_with(')') {
        return None;
    }
    let name = &trimmed[..open];
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return None;
    }
    Some((name, &trimmed[open + 1..trimmed.len() - 1]))
}

fn compare_values(left: &str, right: &str, operator: &str) -> bool {
    let left_number = to_number(left);
    let right_number = to_number(right);
    let both_numeric = left_number.is_some() && right_number.is_some();
    if both_numeric {
        let left = left_number.unwrap_or_default();
        let right = right_number.unwrap_or_default();
        return match operator {
            "==" => left == right,
            "!=" => left != right,
            "<" => left < right,
            ">" => left > right,
            "<=" => left <= right,
            ">=" => left >= right,
            _ => false,
        };
    }

    let left = left.to_lowercase();
    let right = right.to_lowercase();
    match operator {
        "==" => left == right,
        "!=" => left != right,
        "<" => left < right,
        ">" => left > right,
        "<=" => left <= right,
        ">=" => left >= right,
        _ => false,
    }
}

fn to_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok()
}

fn is_truthy(value: &str) -> bool {
    !matches!(value, "" | "false" | "0")
}

fn is_quoted(value: &str) -> bool {
    (value.starts_with('\'') && value.ends_with('\''))
        || (value.starts_with('"') && value.ends_with('"'))
}

fn unquote(value: &str) -> &str {
    if is_quoted(value) {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn json_value_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::Bool(value) => value.to_string(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::String(value) => value.clone(),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
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
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-expr-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn expands_string_functions_and_json_arrays() {
        let context = ExpressionContext::default();

        assert_eq!(
            expand_expressions("${{ format('{0}-{1}', 'foo', 'bar') }}", &context),
            "foo-bar"
        );
        assert_eq!(
            expand_expressions(
                "${{ join(fromJSON('[\"a\",\"b\",\"c\"]'), ',') }}",
                &context
            ),
            "a,b,c"
        );
        assert_eq!(
            expand_expressions("${{ contains(fromJSON('[\"a\",\"b\"]'), 'b') }}", &context),
            "true"
        );
        assert_eq!(
            expand_expressions("${{ startsWith('hello-world', 'hello') }}", &context),
            "true"
        );
        assert_eq!(
            expand_expressions("${{ endsWith('hello-world', 'world') }}", &context),
            "true"
        );
    }

    #[test]
    fn resolves_contexts_and_strategy_values() {
        let mut context = ExpressionContext::default();
        context.matrix.insert("shard".to_owned(), "2".to_owned());
        context
            .matrix
            .insert("__job_total".to_owned(), "3".to_owned());
        context.vars.insert("ENV".to_owned(), "test".to_owned());

        assert_eq!(expand_expressions("${{ matrix.shard }}", &context), "2");
        assert_eq!(
            expand_expressions("${{ strategy.job-total }}", &context),
            "3"
        );
        assert_eq!(expand_expressions("${{ vars.ENV }}", &context), "test");
        assert_eq!(expand_expressions("${{ runner.arch }}", &context), "X64");
    }

    #[test]
    fn supports_boolean_logic_and_comparison_coercion() {
        let context = ExpressionContext::default();

        assert_eq!(
            expand_expressions("${{ true && 'yes' || 'no' }}", &context),
            "yes"
        );
        assert_eq!(expand_expressions("${{ '' == 0 }}", &context), "true");
        assert_eq!(expand_expressions("${{ null == 0 }}", &context), "true");
        assert_eq!(expand_expressions("${{ '0' == 0 }}", &context), "true");
        assert_eq!(expand_expressions("${{ 'x' == 0 }}", &context), "false");
    }

    #[test]
    fn pretty_prints_to_json() {
        let context = ExpressionContext::default();
        let value =
            expand_expressions("${{ toJSON(fromJSON('{\"a\":1,\"b\":\"x\"}')) }}", &context);

        assert!(value.contains('\n'));
        assert!(value.contains("  \"a\": 1"));
    }

    #[test]
    fn hashes_files_and_applies_negation_patterns() {
        let repo = temp_dir("hash");
        fs::create_dir_all(repo.join(".github/workflows")).unwrap();
        fs::write(repo.join(".github/workflows/a.yml"), "a").unwrap();
        fs::write(repo.join(".github/workflows/b.yml"), "b").unwrap();
        let context = ExpressionContext {
            repo_path: Some(repo.clone()),
            ..ExpressionContext::default()
        };

        let one = expand_expressions("${{ hashFiles('.github/workflows/a.yml') }}", &context);
        let all = expand_expressions("${{ hashFiles('.github/workflows/*.yml') }}", &context);
        let excluded = expand_expressions(
            "${{ hashFiles('.github/workflows/*.yml', '!.github/workflows/b.yml') }}",
            &context,
        );

        assert_eq!(one.len(), 64);
        assert_eq!(all.len(), 64);
        assert_eq!(excluded, one);
        assert_ne!(all, excluded);
    }

    #[test]
    fn evaluates_smoke_job_if_condition_as_true_for_owner() {
        let context = ExpressionContext::default();
        let expression = "!github.event.pull_request.draft && (contains(fromJSON('[\"MEMBER\", \"OWNER\", \"COLLABORATOR\"]'), github.event.pull_request.author_association) || contains(github.event.pull_request.labels.*.name, 'safe-to-run'))";

        assert_eq!(evaluate_expr_value(expression, &context), "true");
    }
}
