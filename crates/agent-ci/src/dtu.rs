use crate::runner::{DtuControlPlane, DtuJobSeed, DtuRunnerRegistration};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VIRTUAL_CACHE_ID: u64 = 0;
const TWIRP_ARTIFACT_PREFIX: &str = "/twirp/github.actions.results.api.v1.ArtifactService";

#[derive(Debug)]
pub struct EphemeralDtu {
    pub url: String,
    pub container_url: String,
    pub port: u16,
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EphemeralDtu {
    pub fn close(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start_ephemeral_dtu(
    cache_dir: impl AsRef<Path>,
    container_host: Option<&str>,
) -> std::io::Result<EphemeralDtu> {
    let cache_dir = cache_dir.as_ref().to_path_buf();
    fs::create_dir_all(&cache_dir)?;
    fs::create_dir_all(cache_dir.join("artifacts"))?;

    let listener = TcpListener::bind(("0.0.0.0", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(AtomicBool::new(false));
    let state = Arc::new(DtuState::new(cache_dir));
    let thread_shutdown = Arc::clone(&shutdown);
    let thread_state = Arc::clone(&state);

    let thread = thread::spawn(move || accept_loop(listener, thread_state, thread_shutdown));
    let host = container_host.unwrap_or("host.docker.internal");

    Ok(EphemeralDtu {
        url: format!("http://127.0.0.1:{port}"),
        container_url: format!("http://{host}:{port}"),
        port,
        shutdown,
        thread: Some(thread),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuHttpClient {
    base_url: String,
}

impl DtuHttpClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
        }
    }

    fn post_json(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request_json("POST", path, Some(body))
    }

    fn request_json(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let (host, port) = parse_http_base_url(&self.base_url)?;
        let body_bytes = body
            .map(|value| serde_json::to_vec(&value).map_err(|err| err.to_string()))
            .transpose()?
            .unwrap_or_default();
        let mut stream = TcpStream::connect((host.as_str(), port))
            .map_err(|err| format!("failed to connect to DTU at {}: {err}", self.base_url))?;
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body_bytes.len()
        )
        .map_err(|err| err.to_string())?;
        stream
            .write_all(&body_bytes)
            .map_err(|err| err.to_string())?;

        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .map_err(|err| err.to_string())?;
        parse_json_response(&response)
    }
}

impl DtuControlPlane for DtuHttpClient {
    fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String> {
        self.post_json(
            "/_dtu/start-runner",
            json!({
                "runnerName": registration.runner_name,
                "logDir": registration.log_dir,
                "timelineDir": registration.timeline_dir,
                "virtualCachePatterns": registration.virtual_cache_patterns,
            }),
        )
        .map(|_| ())
    }

    fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String> {
        self.post_json("/_dtu/seed", seed.to_payload()).map(|_| ())
    }
}

fn parse_http_base_url(base_url: &str) -> Result<(String, u16), String> {
    let rest = base_url
        .strip_prefix("http://")
        .ok_or_else(|| format!("DTU URL must start with http://, got {base_url}"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| format!("DTU URL must include a port, got {base_url}"))?;
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("DTU URL has an invalid port, got {base_url}"))?;
    Ok((host.to_owned(), port))
}

fn parse_json_response(response: &[u8]) -> Result<Value, String> {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err("DTU response did not contain HTTP headers".to_owned());
    };
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "DTU response did not contain a status code".to_owned())?;
    let body = &response[header_end + 4..];
    if !(200..300).contains(&status) {
        return Err(format!(
            "DTU request failed with HTTP {status}: {}",
            String::from_utf8_lossy(body)
        ));
    }
    if body.is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_slice(body).map_err(|err| err.to_string())
    }
}

#[derive(Debug)]
struct DtuState {
    cache_dir: PathBuf,
    jobs: Mutex<BTreeMap<String, Value>>,
    runner_jobs: Mutex<BTreeMap<String, Value>>,
    sessions: Mutex<BTreeMap<String, Value>>,
    session_to_runner: Mutex<BTreeMap<String, String>>,
    runner_logs: Mutex<BTreeMap<String, String>>,
    runner_timeline_dirs: Mutex<BTreeMap<String, String>>,
    timeline_to_log_dir: Mutex<BTreeMap<String, String>>,
    plan_to_log_dir: Mutex<BTreeMap<String, String>>,
    record_to_step_name: Mutex<BTreeMap<String, String>>,
    current_in_progress_step: Mutex<BTreeMap<String, String>>,
    caches: Mutex<BTreeMap<String, CacheEntry>>,
    pending_caches: Mutex<BTreeMap<u64, PendingCache>>,
    virtual_cache_patterns: Mutex<BTreeSet<String>>,
    pending_artifacts: Mutex<BTreeMap<u64, PendingArtifact>>,
    artifacts: Mutex<BTreeMap<String, Artifact>>,
    artifact_blocks: Mutex<BTreeMap<u64, BTreeMap<String, Vec<u8>>>>,
    repo_root: Mutex<Option<String>>,
    next_id: AtomicU64,
}

impl DtuState {
    fn new(cache_dir: PathBuf) -> Self {
        let caches = load_caches_from_disk(&cache_dir);
        Self {
            cache_dir,
            jobs: Mutex::new(BTreeMap::new()),
            runner_jobs: Mutex::new(BTreeMap::new()),
            sessions: Mutex::new(BTreeMap::new()),
            session_to_runner: Mutex::new(BTreeMap::new()),
            runner_logs: Mutex::new(BTreeMap::new()),
            runner_timeline_dirs: Mutex::new(BTreeMap::new()),
            timeline_to_log_dir: Mutex::new(BTreeMap::new()),
            plan_to_log_dir: Mutex::new(BTreeMap::new()),
            record_to_step_name: Mutex::new(BTreeMap::new()),
            current_in_progress_step: Mutex::new(BTreeMap::new()),
            caches: Mutex::new(caches),
            pending_caches: Mutex::new(BTreeMap::new()),
            virtual_cache_patterns: Mutex::new(BTreeSet::new()),
            pending_artifacts: Mutex::new(BTreeMap::new()),
            artifacts: Mutex::new(BTreeMap::new()),
            artifact_blocks: Mutex::new(BTreeMap::new()),
            repo_root: Mutex::new(None),
            next_id: AtomicU64::new(now_ms() as u64),
        }
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_virtual_cache_key(&self, key: &str) -> bool {
        self.virtual_cache_patterns
            .lock()
            .expect("virtual cache lock")
            .iter()
            .any(|pattern| key.contains(pattern))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CacheEntry {
    version: String,
    archive_location: String,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingCache {
    temp_path: PathBuf,
    key: String,
    version: String,
}

fn load_caches_from_disk(cache_dir: &Path) -> BTreeMap<String, CacheEntry> {
    let path = cache_dir.join("caches.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    object
        .into_iter()
        .map(|(key, value)| {
            (
                key,
                CacheEntry {
                    version: value
                        .get("version")
                        .map(value_to_string)
                        .unwrap_or_default(),
                    archive_location: value
                        .get("archiveLocation")
                        .or_else(|| value.get("archive_location"))
                        .map(value_to_string)
                        .unwrap_or_default(),
                    size: value.get("size").and_then(Value::as_u64).unwrap_or(0),
                },
            )
        })
        .collect()
}

fn save_caches_to_disk(state: &DtuState) {
    let _ = fs::create_dir_all(&state.cache_dir);
    let value = {
        let caches = state.caches.lock().expect("caches lock");
        let object = caches
            .iter()
            .map(|(key, entry)| {
                (
                    key.clone(),
                    json!({
                        "version": entry.version,
                        "archiveLocation": entry.archive_location,
                        "size": entry.size,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        Value::Object(object)
    };
    let _ = fs::write(
        state.cache_dir.join("caches.json"),
        serde_json::to_vec_pretty(&value).unwrap_or_default(),
    );
}

fn cache_id_from_archive_location(location: &str) -> Option<u64> {
    location
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|id| id.parse::<u64>().ok())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingArtifact {
    name: String,
    files: BTreeMap<String, PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Artifact {
    container_id: u64,
    files: BTreeMap<String, PathBuf>,
}

fn accept_loop(listener: TcpListener, state: Arc<DtuState>, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let state = Arc::clone(&state);
                thread::spawn(move || handle_connection(stream, state));
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

fn handle_connection(mut stream: TcpStream, state: Arc<DtuState>) {
    let debug = std::env::var("AGENT_CI_DTU_DEBUG").is_ok_and(|value| value == "1");
    let response = match read_request(&mut stream) {
        Ok(request) => {
            let response = route_request(&request, &state);
            if debug {
                eprintln!(
                    "[DTU] {} {} -> {}",
                    request.method, request.path, response.status
                );
            }
            if let Some(file) = std::env::var_os("AGENT_CI_DTU_DEBUG_FILE") {
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut file| {
                        writeln!(
                            file,
                            "{} {} -> {} body={} {:?}",
                            request.method,
                            request.path,
                            response.status,
                            request.body.len(),
                            String::from_utf8_lossy(&request.body)
                                .chars()
                                .take(200)
                                .collect::<String>()
                        )
                    });
            }
            response
        }
        Err(err) => {
            if debug {
                eprintln!("[DTU] Bad request: {err}");
            }
            if let Some(file) = std::env::var_os("AGENT_CI_DTU_DEBUG_FILE") {
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut file| writeln!(file, "BAD REQUEST {err}"));
            }
            Response::text(400, format!("Bad Request: {err}"))
        }
    };
    let _ = write_response(&mut stream, response);
    let _ = stream.flush();
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Request {
    method: String,
    path: String,
    query: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Response {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    content_length: Option<usize>,
    extra_headers: BTreeMap<String, String>,
}

impl Response {
    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain".to_owned(),
            body: Vec::new(),
            content_length: Some(0),
            extra_headers: BTreeMap::new(),
        }
    }

    fn text(status: u16, text: impl Into<String>) -> Self {
        let body = text.into().into_bytes();
        Self {
            status,
            content_type: "text/plain".to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    fn json(status: u16, value: Value) -> Self {
        let body = serde_json::to_vec(&value).unwrap_or_default();
        Self {
            status,
            content_type: "application/json; charset=utf-8".to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_owned(),
            content_length: Some(body.len()),
            body,
            extra_headers: BTreeMap::new(),
        }
    }

    fn streaming_bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_owned(),
            content_length: None,
            body,
            extra_headers: BTreeMap::new(),
        }
    }
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| err.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    let header_end;

    loop {
        let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
        if read == 0 {
            return Err("connection closed before headers".to_owned());
        }
        buffer.extend_from_slice(&temp[..read]);
        if let Some(pos) = find_header_end(&buffer) {
            header_end = pos;
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return Err("headers too large".to_owned());
        }
    }

    let header = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_owned())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "missing method".to_owned())?
        .to_owned();
    let target = request_parts
        .next()
        .ok_or_else(|| "missing target".to_owned())?;
    let (path, query) = split_target(target);
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        body = read_chunked_body(stream, body, &mut temp)?;
    } else {
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        while body.len() < content_length {
            let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&temp[..read]);
        }
        body.truncate(content_length);
    }

    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_chunked_body(
    stream: &mut TcpStream,
    mut encoded: Vec<u8>,
    temp: &mut [u8; 4096],
) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let mut cursor = 0;
    loop {
        let line_end = loop {
            if let Some(relative) = encoded[cursor..]
                .windows(2)
                .position(|window| window == b"\r\n")
            {
                break cursor + relative;
            }
            let read = stream.read(temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("connection closed while reading chunk size".to_owned());
            }
            encoded.extend_from_slice(&temp[..read]);
        };
        let size_line =
            std::str::from_utf8(&encoded[cursor..line_end]).map_err(|err| err.to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or(size_line).trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("invalid chunk size: {size_line}"))?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        while encoded.len() < cursor + size + 2 {
            let read = stream.read(temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("connection closed while reading chunk body".to_owned());
            }
            encoded.extend_from_slice(&temp[..read]);
        }
        decoded.extend_from_slice(&encoded[cursor..cursor + size]);
        cursor += size;
        if encoded.get(cursor..cursor + 2) != Some(b"\r\n") {
            return Err("chunk body missing trailing CRLF".to_owned());
        }
        cursor += 2;
    }
}

fn split_target(target: &str) -> (String, BTreeMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            Some((url_decode(key)?, url_decode(value).unwrap_or_default()))
        })
        .collect();
    (path.to_owned(), query)
}

fn url_decode(value: &str) -> Option<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let status_text = status_text(response.status);
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nConnection: close\r\n",
        response.status, status_text, response.content_type
    )?;
    if let Some(content_length) = response.content_length {
        write!(stream, "Content-Length: {content_length}\r\n")?;
    }
    for (key, value) in response.extra_headers {
        write!(stream, "{key}: {value}\r\n")?;
    }
    stream.write_all(b"\r\n")?;
    stream.write_all(&response.body)
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn route_request(request: &Request, state: &Arc<DtuState>) -> Response {
    let segments = path_segments(&request.path);

    if request.method == "OPTIONS" {
        return resource_locations();
    }
    if request.method == "GET" && request.path.trim_end_matches('/') == "/_apis" {
        return Response::json(200, json!({ "value": [] }));
    }

    if request.path == "/_dtu/dump" && request.method == "GET" {
        return dump_state(state);
    }
    if request.path == "/_dtu/seed" && request.method == "POST" {
        return seed_job(request, state);
    }
    if request.path == "/_dtu/start-runner" && request.method == "POST" {
        return start_runner(request, state);
    }
    if request.method == "GET"
        && segments.len() >= 5
        && segments[0] == "_dtu"
        && segments[1] == "action-tarball"
    {
        return action_tarball(state, segments[2], segments[3], &segments[4..].join("/"));
    }

    if let Some(response) = route_github(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_runner(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_cache(request, state, &segments) {
        return response;
    }
    if let Some(response) = route_artifacts(request, state, &segments) {
        return response;
    }

    Response::json(404, json!({ "message": "Not Found (DTU Rust Mock)" }))
}

fn path_segments(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn request_json(request: &Request) -> Value {
    serde_json::from_slice(&request.body).unwrap_or(Value::Null)
}

fn dump_state(state: &DtuState) -> Response {
    Response::json(
        200,
        json!({
            "jobs": state.jobs.lock().expect("jobs lock").clone(),
            "runnerJobs": state.runner_jobs.lock().expect("runner jobs lock").clone(),
            "runnerLogs": state.runner_logs.lock().expect("runner logs lock").clone(),
            "runnerTimelineDirs": state.runner_timeline_dirs.lock().expect("timeline dirs lock").clone(),
            "sessions": state.sessions.lock().expect("sessions lock").clone(),
            "sessionToRunner": state.session_to_runner.lock().expect("session runner lock").clone(),
            "caches": state.caches.lock().expect("caches lock").keys().cloned().collect::<Vec<_>>(),
            "artifacts": state.artifacts.lock().expect("artifacts lock").keys().cloned().collect::<Vec<_>>()
        }),
    )
}

fn seed_job(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(job_id) = payload
        .get("id")
        .map(value_to_string)
        .filter(|value| !value.is_empty())
    else {
        return Response::json(400, json!({ "error": "Missing job ID" }));
    };

    if let Some(repo_root) = payload.get("repoRoot").and_then(Value::as_str) {
        *state.repo_root.lock().expect("repo root lock") = Some(repo_root.to_owned());
    }

    if let Some(runner_name) = payload.get("runnerName").and_then(Value::as_str) {
        state
            .runner_jobs
            .lock()
            .expect("runner jobs lock")
            .insert(runner_name.to_owned(), payload);
    } else {
        state
            .jobs
            .lock()
            .expect("jobs lock")
            .insert(job_id.clone(), payload);
    }
    Response::json(201, json!({ "status": "ok", "jobId": job_id }))
}

fn action_tarball(state: &DtuState, owner: &str, repo: &str, reference: &str) -> Response {
    let repo_path = format!("{owner}/{repo}");
    let safe_ref = reference.replace(['/', '\\', ':'], "_");
    let dest = state
        .cache_dir
        .join("action-tarballs")
        .join(owner)
        .join(repo)
        .join(format!("{safe_ref}.tar.gz"));
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = dest.with_extension("tar.gz.tmp");
        let url = format!("https://api.github.com/repos/{repo_path}/tarball/{reference}");
        let status = std::process::Command::new("curl")
            .args(["-fsSL", "-A", "agent-ci/1.0", "-o"])
            .arg(&tmp)
            .arg(&url)
            .status();
        match status {
            Ok(status) if status.success() => {
                let _ = fs::rename(&tmp, &dest);
            }
            Ok(status) => {
                let _ = fs::remove_file(&tmp);
                return Response::text(502, format!("failed to download action tarball: {status}"));
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Response::text(502, format!("failed to run curl: {err}"));
            }
        }
    }

    match fs::read(&dest) {
        Ok(bytes) => Response::streaming_bytes(200, "application/x-tar", bytes),
        Err(err) => Response::text(502, format!("failed to read action tarball: {err}")),
    }
}

fn start_runner(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    if let (Some(runner_name), Some(log_dir)) = (
        payload.get("runnerName").and_then(Value::as_str),
        payload.get("logDir").and_then(Value::as_str),
    ) {
        let _ = fs::create_dir_all(log_dir);
        state
            .runner_logs
            .lock()
            .expect("runner logs lock")
            .insert(runner_name.to_owned(), log_dir.to_owned());
        if let Some(timeline_dir) = payload.get("timelineDir").and_then(Value::as_str) {
            state
                .runner_timeline_dirs
                .lock()
                .expect("timeline dirs lock")
                .insert(runner_name.to_owned(), timeline_dir.to_owned());
        }
        if let Some(patterns) = payload
            .get("virtualCachePatterns")
            .and_then(Value::as_array)
        {
            let mut virtual_patterns = state
                .virtual_cache_patterns
                .lock()
                .expect("virtual patterns lock");
            for pattern in patterns.iter().filter_map(Value::as_str) {
                virtual_patterns.insert(pattern.to_owned());
            }
        }
    }
    Response::json(200, json!({ "ok": true }))
}

fn route_github(request: &Request, state: &DtuState, segments: &[&str]) -> Option<Response> {
    if request.method == "POST"
        && segments.len() == 4
        && segments[0] == "app"
        && segments[1] == "installations"
        && segments[3] == "access_tokens"
    {
        return Some(Response::json(
            201,
            json!({
                "token": format!("ghs_mock_token_{}_{}", segments[2], state.next_id()),
                "expires_at": iso_now_plus_hour(),
                "permissions": { "actions": "read", "metadata": "read" },
                "repository_selection": "selected"
            }),
        ));
    }

    if segments.len() >= 4 && segments[0] == "repos" {
        let owner = segments[1];
        let repo = segments[2];
        if request.method == "GET" && segments.len() == 4 && segments[3] == "installation" {
            return Some(Response::json(
                200,
                json!({
                    "id": 12345678,
                    "account": { "login": owner, "type": "User" },
                    "repository_selection": "all",
                    "access_tokens_url": format!("{}/app/installations/12345678/access_tokens", base_url(request))
                }),
            ));
        }
        if request.method == "POST"
            && segments.len() == 6
            && segments[3] == "actions"
            && segments[4] == "runners"
            && segments[5] == "registration-token"
        {
            return Some(registration_token(state));
        }
        if request.method == "GET"
            && segments.len() == 6
            && segments[3] == "actions"
            && segments[4] == "jobs"
        {
            let job_id = segments[5];
            let job = state.jobs.lock().expect("jobs lock").get(job_id).cloned();
            return Some(job.map_or_else(
                || Response::json(404, json!({ "message": "Not Found (DTU Mock)" })),
                |job| Response::json(200, job),
            ));
        }
        if request.method == "GET" && segments.len() == 5 && segments[3] == "compare" {
            return Some(compare_commits(segments[4], state));
        }
        if request.method == "GET"
            && segments.len() == 6
            && segments[3] == "commits"
            && segments[5] == "pulls"
        {
            return Some(Response::json(200, json!([])));
        }
        if request.method == "GET" && segments.len() == 6 && segments[3] == "tarball" {
            return Some(empty_tarball_response());
        }
        let _ = (owner, repo);
    }

    if request.method == "POST"
        && segments.len() == 7
        && segments[0] == "api"
        && segments[1] == "v3"
        && segments[2] == "repos"
        && segments[5] == "runners"
        && segments[6] == "registration-token"
    {
        return Some(registration_token(state));
    }

    if request.method == "POST"
        && segments.len() == 2
        && segments[0] == "actions"
        && segments[1] == "runner-registration"
    {
        return Some(global_runner_registration(request, state));
    }
    if request.method == "POST"
        && segments.len() == 4
        && segments[0] == "api"
        && segments[1] == "v3"
        && segments[2] == "actions"
        && segments[3] == "runner-registration"
    {
        return Some(global_runner_registration(request, state));
    }

    None
}

fn registration_token(state: &DtuState) -> Response {
    Response::json(
        201,
        json!({
            "token": format!("ghr_mock_registration_token_{}", state.next_id()),
            "expires_at": iso_now_plus_hour()
        }),
    )
}

fn global_runner_registration(request: &Request, state: &DtuState) -> Response {
    Response::json(
        200,
        json!({
            "token": format!("ghr_mock_tenant_token_{}", state.next_id()),
            "token_schema": "OAuthAccessToken",
            "authorization_url": format!("{}/auth/authorize", base_url(request)),
            "client_id": "mock-client-id",
            "tenant_id": "mock-tenant-id",
            "expiration": iso_now_plus_hour(),
            "url": base_url(request)
        }),
    )
}

fn compare_commits(basehead: &str, state: &DtuState) -> Response {
    let parts = basehead
        .split("...")
        .flat_map(|part| part.split(".."))
        .collect::<Vec<_>>();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Response::json(422, json!({ "message": "Invalid basehead format" }));
    }
    let Some(repo_root) = state.repo_root.lock().expect("repo root lock").clone() else {
        return Response::json(
            200,
            json!({ "status": "identical", "files": [], "total_commits": 0, "commits": [] }),
        );
    };
    let output = std::process::Command::new("git")
        .args(["diff", "--name-status", parts[0], parts[1]])
        .current_dir(repo_root)
        .output();
    let files = output
        .ok()
        .filter(|out| out.status.success())
        .map_or_else(Vec::new, |out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    let parts = line.split('\t').collect::<Vec<_>>();
                    let raw_status = *parts.first()?;
                    let filename = if raw_status.starts_with('R') {
                        parts.get(2)?
                    } else {
                        parts.get(1)?
                    };
                    Some(json!({
                        "sha": "0000000000000000000000000000000000000000",
                        "filename": filename,
                        "status": match raw_status.chars().next().unwrap_or('M') {
                            'A' => "added",
                            'D' => "removed",
                            'R' => "renamed",
                            _ => "modified",
                        },
                        "additions": 0,
                        "deletions": 0,
                        "changes": 0
                    }))
                })
                .collect()
        });
    Response::json(
        200,
        json!({ "status": if files.is_empty() { "identical" } else { "ahead" }, "total_commits": 1, "commits": [], "files": files }),
    )
}

fn empty_tarball_response() -> Response {
    // A tiny empty gzip stream. It is enough for route/contract tests; execution
    // mode still uses the TypeScript DTU until the runner is fully ported.
    Response::bytes(
        200,
        "application/gzip",
        vec![
            0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x03, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
    )
}

fn route_runner(request: &Request, state: &DtuState, segments: &[&str]) -> Option<Response> {
    if request.method == "GET"
        && matches!(
            request.path.as_str(),
            "/_apis/pipelines" | "/_apis/connectionData"
        )
    {
        return Some(service_discovery(request));
    }
    if request.method == "GET" && segments == ["_apis", "distributedtask", "pools"] {
        return Some(Response::json(
            200,
            json!({ "count": 1, "value": [{ "id": 1, "name": "Default", "isHosted": false, "autoProvision": true }] }),
        ));
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "agents"
    {
        if request.method == "GET" {
            return Some(Response::json(200, json!({ "count": 0, "value": [] })));
        }
        if request.method == "POST" {
            let payload = request_json(request);
            let agent_id = state.next_id();
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("agent-ci-runner");
            return Some(Response::json(
                200,
                json!({
                    "id": agent_id,
                    "name": name,
                    "version": payload.get("version").and_then(Value::as_str).unwrap_or("2.331.0"),
                    "osDescription": payload.get("osDescription").and_then(Value::as_str).unwrap_or("Linux"),
                    "ephemeral": true,
                    "disableUpdate": true,
                    "enabled": true,
                    "status": "online",
                    "provisioningState": "Provisioned",
                    "authorization": { "clientId": format!("mock-client-{}", state.next_id()), "authorizationUrl": format!("{}/auth/authorize", base_url(request)) },
                    "accessPoint": format!("{}/_apis/distributedtask/pools/{}/agents/{agent_id}", base_url(request), segments[3])
                }),
            ));
        }
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "sessions"
        && request.method == "POST"
    {
        let payload = request_json(request);
        let session_id = mock_uuid(state.next_id());
        let owner_name = payload
            .pointer("/agent/name")
            .and_then(Value::as_str)
            .unwrap_or("agent-ci-runner");
        let response = json!({
            "sessionId": session_id,
            "ownerName": owner_name,
            "agent": { "id": 1, "name": owner_name, "version": "2.331.0", "osDescription": "Linux", "enabled": true, "status": "online" },
            "encryptionKey": { "value": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "k": "encryptionKey" }
        });
        state
            .sessions
            .lock()
            .expect("sessions lock")
            .insert(session_id.clone(), response.clone());
        state
            .session_to_runner
            .lock()
            .expect("session runner lock")
            .insert(session_id, owner_name.to_owned());
        return Some(Response::json(200, response));
    }
    if segments.len() == 6
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "sessions"
        && request.method == "DELETE"
    {
        let session_id = segments[5];
        state
            .sessions
            .lock()
            .expect("sessions lock")
            .remove(session_id);
        state
            .session_to_runner
            .lock()
            .expect("session runner lock")
            .remove(session_id);
        return Some(Response::empty(204));
    }
    if segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "pools"]
        && segments[4] == "messages"
    {
        if request.method == "DELETE" {
            return Some(Response::empty(204));
        }
        if request.method == "GET" {
            return Some(poll_message(request, state));
        }
    }
    if segments.len() >= 3
        && segments[0..3] == ["_apis", "distributedtask", "jobrequests"]
        && request.method == "PATCH"
    {
        let mut payload = request_json(request);
        if payload.get("result").is_none() && payload.get("finishTime").is_none() {
            payload["lockedUntil"] = json!(iso_now_plus_minute());
        }
        return Some(Response::json(200, payload));
    }
    if request.path == "/_apis/distributedtask/jobrequests" && request.method == "PATCH" {
        return Some(Response::json(200, request_json(request)));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "logs"
    {
        let log_id = state.next_id();
        return Some(Response::json(
            201,
            json!({
                "id": log_id,
                "path": format!("logs/{log_id}"),
                "createdOn": iso_now(),
                "location": format!("{}/_apis/distributedtask/hubs/{}/plans/{}/logs/{log_id}", base_url(request), segments[3], segments[5])
            }),
        ));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 9
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "logs"
        && segments[8] == "lines"
    {
        append_log_lines(request, state, segments[5], segments[7]);
        return Some(Response::json(200, json!({ "count": 0, "value": [] })));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 11
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "timelines"
        && segments[8] == "records"
        && segments[10] == "feed"
    {
        append_timeline_feed(request, state, segments[5], segments[9]);
        return Some(Response::json(200, json!({ "count": 0, "value": [] })));
    }
    if (request.method == "PATCH" || request.method == "POST")
        && segments.len() == 5
        && segments[0..3] == ["_apis", "distributedtask", "timelines"]
        && segments[4] == "records"
    {
        return Some(timeline_records(request, state, segments[3]));
    }
    if request.method == "GET"
        && segments.len() == 4
        && segments[0..3] == ["_apis", "distributedtask", "timelines"]
    {
        return Some(timeline_get(state, segments[3]));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "outputs"
    {
        return Some(capture_outputs(request, state, segments[5]));
    }
    if request.method == "POST"
        && segments.len() == 7
        && segments[0..3] == ["_apis", "distributedtask", "hubs"]
        && segments[4] == "plans"
        && segments[6] == "actiondownloadinfo"
    {
        return Some(action_download_info(request));
    }
    None
}

fn capture_outputs(request: &Request, state: &DtuState, plan_id: &str) -> Response {
    let payload = request_json(request);
    if let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    {
        let path = PathBuf::from(log_dir).join("outputs.json");
        let mut existing = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
            .unwrap_or_default();
        flatten_output_payload("", &payload, &mut existing);
        let _ = fs::write(
            path,
            serde_json::to_vec_pretty(&Value::Object(existing)).unwrap_or_default(),
        );
    }
    Response::json(200, json!({ "value": {} }))
}

fn flatten_output_payload(prefix: &str, value: &Value, out: &mut serde_json::Map<String, Value>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, value) in object {
        if let Some(output_value) = value.get("value") {
            let flat_key = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.insert(flat_key, output_value.clone());
            out.insert(key.clone(), output_value.clone());
        } else if value.is_object() {
            let nested_prefix = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            flatten_output_payload(&nested_prefix, value, out);
        } else {
            let flat_key = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            out.insert(flat_key, value.clone());
            out.insert(key.clone(), value.clone());
        }
    }
}

fn action_download_info(request: &Request) -> Response {
    let payload = request_json(request);
    let base = base_url(request);
    let mut actions = serde_json::Map::new();
    for action in payload
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name_with_owner) = action.get("nameWithOwner").and_then(Value::as_str) else {
            continue;
        };
        if name_with_owner.starts_with("./") {
            continue;
        }
        let Some(reference) = action.get("ref").and_then(Value::as_str) else {
            continue;
        };
        let repo_path = name_with_owner
            .split('/')
            .take(2)
            .collect::<Vec<_>>()
            .join("/");
        let mut parts = repo_path.split('/');
        let Some(owner) = parts.next() else { continue };
        let Some(repo) = parts.next() else { continue };
        let key = format!("{name_with_owner}@{reference}");
        let local_url = format!("{base}/_dtu/action-tarball/{owner}/{repo}/{reference}");
        let url = std::env::var("AGENT_CI_RUST_ACTION_TARBALL_BASE")
            .map(|base| format!("{base}/_dtu/action-tarball/{owner}/{repo}/{reference}"))
            .unwrap_or(local_url);
        let mut hasher = Sha1::new();
        hasher.update(key.as_bytes());
        actions.insert(
            key,
            json!({
                "nameWithOwner": name_with_owner,
                "resolvedNameWithOwner": name_with_owner,
                "ref": reference,
                "resolvedSha": format!("{:x}", hasher.finalize()),
                "tarballUrl": url,
                "zipballUrl": url,
                "authentication": null,
            }),
        );
    }
    Response::json(200, json!({ "actions": actions }))
}

fn resource_locations() -> Response {
    Response::json(
        200,
        json!({
            "count": 10,
            "value": [
                { "id": "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", "area": "distributedtask", "resourceName": "pools", "routeTemplate": "_apis/distributedtask/pools/{poolId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "E298EF32-5878-4CAB-993C-043836571F42", "area": "distributedtask", "resourceName": "agents", "routeTemplate": "_apis/distributedtask/pools/{poolId}/agents/{agentId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "C3A054F6-7A8A-49C0-944E-3A8E5D7ADFD7", "area": "distributedtask", "resourceName": "messages", "routeTemplate": "_apis/distributedtask/pools/{poolId}/messages", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "134E239E-2DF3-4794-A6F6-24F1F19EC8DC", "area": "distributedtask", "resourceName": "sessions", "routeTemplate": "_apis/distributedtask/pools/{poolId}/sessions/{sessionId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0" },
                { "id": "83597576-CC2C-453C-BEA6-2882AE6A1653", "area": "distributedtask", "resourceName": "timelines", "routeTemplate": "_apis/distributedtask/timelines/{timelineId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "27d7f831-88c1-4719-8ca1-6a061dad90eb", "area": "distributedtask", "resourceName": "actiondownloadinfo", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "6.0", "releasedVersion": "6.0" },
                { "id": "858983e4-19bd-4c5e-864c-507b59b58b12", "area": "distributedtask", "resourceName": "feed", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "46f5667d-263a-4684-91b1-dff7fdcf64e2", "area": "distributedtask", "resourceName": "logs", "routeTemplate": "_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "8893BC5B-35B2-4BE7-83CB-99E683551DB4", "area": "distributedtask", "resourceName": "records", "routeTemplate": "_apis/distributedtask/timelines/{timelineId}/records/{recordId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" },
                { "id": "FC825784-C92A-4299-9221-998A02D1B54F", "area": "distributedtask", "resourceName": "jobrequests", "routeTemplate": "_apis/distributedtask/jobrequests/{jobId}", "resourceVersion": 1, "minVersion": "1.0", "maxVersion": "9.0", "releasedVersion": "9.0" }
            ]
        }),
    )
}

fn service_discovery(request: &Request) -> Response {
    let base = base_url(request);
    Response::json(
        200,
        json!({
            "value": [],
            "locationId": "11111111-1111-1111-1111-111111111111",
            "instanceId": "22222222-2222-2222-2222-222222222222",
            "locationServiceData": {
                "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
                "defaultAccessMappingMoniker": "PublicAccessMapping",
                "accessMappings": [
                    { "moniker": "PublicAccessMapping", "displayName": "Public Access", "accessPoint": base }
                ],
                "serviceDefinitions": [
                    { "serviceType": "distributedtask", "identifier": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "displayName": "distributedtask", "relativeToSetting": 3, "relativePath": "", "description": "Distributed Task Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", "displayName": "Pools", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/pools", "description": "Pools Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": format!("{base}/_apis/distributedtask/pools") }] },
                    { "serviceType": "distributedtask", "identifier": "134e239e-2df3-4794-a6f6-24f1f19ec8dc", "displayName": "TaskAgentSessions", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/pools/{poolId}/sessions", "description": "Task Agent Sessions", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "27d7f831-88c1-4719-8ca1-6a061dad90eb", "displayName": "ActionDownloadInfo", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo", "description": "Action Download Info Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "858983e4-19bd-4c5e-864c-507b59b58b12", "displayName": "AppendTimelineRecordFeed", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed", "description": "Timeline Feed Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] },
                    { "serviceType": "distributedtask", "identifier": "46f5667d-263a-4684-91b1-dff7fdcf64e2", "displayName": "Task Log", "relativeToSetting": 3, "relativePath": "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}", "description": "Task Log Service", "serviceOwner": "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD", "status": 1, "locationMappings": [{ "accessMappingMoniker": "PublicAccessMapping", "location": base }] }
                ]
            }
        }),
    )
}

fn poll_message(request: &Request, state: &DtuState) -> Response {
    let Some(session_id) = request.query.get("sessionId") else {
        return Response::text(404, "Session not found");
    };
    if !state
        .sessions
        .lock()
        .expect("sessions lock")
        .contains_key(session_id)
    {
        return Response::text(404, "Session not found");
    }
    let runner_name = state
        .session_to_runner
        .lock()
        .expect("session runner lock")
        .get(session_id)
        .cloned();
    let runner_job = runner_name.as_ref().and_then(|name| {
        state
            .runner_jobs
            .lock()
            .expect("runner jobs lock")
            .remove(name)
    });
    let generic_job = if runner_job.is_none() {
        let first = state.jobs.lock().expect("jobs lock").keys().next().cloned();
        first.and_then(|id| {
            state
                .jobs
                .lock()
                .expect("jobs lock")
                .remove(&id)
                .map(|job| (id, job))
        })
    } else {
        None
    };
    let Some((job_id, job_data)) = runner_job
        .map(|job| {
            (
                runner_name.clone().unwrap_or_else(|| "runner".to_owned()),
                job,
            )
        })
        .or(generic_job)
    else {
        return Response::empty(204);
    };
    let plan_id = mock_uuid(state.next_id());
    if let Some(name) = runner_name {
        if let Some(log_dir) = state
            .runner_logs
            .lock()
            .expect("runner logs lock")
            .get(&name)
            .cloned()
        {
            state
                .plan_to_log_dir
                .lock()
                .expect("plan log lock")
                .insert(plan_id.clone(), log_dir);
        }
    }
    Response::json(
        200,
        create_job_response(&job_id, &job_data, request, &plan_id, state),
    )
}

fn create_job_response(
    job_id: &str,
    job_data: &Value,
    request: &Request,
    plan_id: &str,
    state: &DtuState,
) -> Value {
    let timeline_id = mock_uuid(state.next_id());
    if let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    {
        state
            .timeline_to_log_dir
            .lock()
            .expect("timeline lock")
            .insert(timeline_id.clone(), log_dir);
    }

    let base = base_url(request);
    let repo_full_name = string_field(job_data, &["githubRepo"])
        .or_else(|| {
            job_data
                .pointer("/repository/full_name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    let owner_name = job_data
        .pointer("/repository/owner/login")
        .and_then(Value::as_str)
        .unwrap_or_else(|| repo_full_name.split('/').next().unwrap_or("redwoodjs"));
    let repo_name = job_data
        .pointer("/repository/name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| repo_full_name.split('/').nth(1).unwrap_or("repo"));
    let real_head_sha = string_field(job_data, &["realHeadSha"])
        .or_else(|| string_field(job_data, &["headSha"]))
        .unwrap_or_else(|| "HEAD".to_owned());
    let workflow_name =
        string_field(job_data, &["workflowName"]).unwrap_or_else(|| "local-workflow".to_owned());
    let job_name = string_field(job_data, &["name", "id"]).unwrap_or_else(|| job_id.to_owned());
    let workspace_root = string_field(job_data, &["runnerWorkDir"])
        .unwrap_or_else(|| "/home/runner/_work".to_owned());
    let workspace_path = format!("{workspace_root}/{repo_name}/{repo_name}");
    let runner_os = string_field(job_data, &["runnerOs"]).unwrap_or_else(|| "Linux".to_owned());
    let runner_arch = string_field(job_data, &["runnerArch"]).unwrap_or_else(|| "X64".to_owned());
    let (runner_temp, runner_tool_cache) = if runner_os.eq_ignore_ascii_case("macos") {
        (
            "/Users/admin/agent-ci-runner/_work/_temp",
            "/Users/admin/hostedtoolcache",
        )
    } else {
        ("/tmp/runner", "/opt/hostedtoolcache")
    };
    let generated_job_id = mock_uuid(state.next_id());
    let mock_token = create_mock_jwt(plan_id, &generated_job_id);
    let mut job_env = string_map_from_value(job_data.get("env"));
    job_env
        .entry("ACTIONS_CACHE_URL".to_owned())
        .or_insert_with(|| format!("{base}/"));
    job_env
        .entry("ACTIONS_RESULTS_URL".to_owned())
        .or_insert_with(|| format!("{base}/"));
    let context_env = job_env.clone();

    let mut variables = json!({
        "CI": { "Value": "true", "IsSecret": false },
        "GITHUB_CI": { "Value": "true", "IsSecret": false },
        "GITHUB_ACTIONS": { "Value": "true", "IsSecret": false },
        "RUNNER_OS": { "Value": runner_os, "IsSecret": false },
        "RUNNER_ARCH": { "Value": runner_arch, "IsSecret": false },
        "RUNNER_NAME": { "Value": "oa-local-runner", "IsSecret": false },
        "RUNNER_TEMP": { "Value": runner_temp, "IsSecret": false },
        "RUNNER_TOOL_CACHE": { "Value": runner_tool_cache, "IsSecret": false },
        "GITHUB_RUN_ID": { "Value": "1", "IsSecret": false },
        "GITHUB_RUN_NUMBER": { "Value": "1", "IsSecret": false },
        "GITHUB_JOB": { "Value": job_name, "IsSecret": false },
        "GITHUB_EVENT_NAME": { "Value": "push", "IsSecret": false },
        "GITHUB_API_URL": { "Value": base, "IsSecret": false },
        "ACTIONS_CACHE_URL": { "Value": format!("{base}/"), "IsSecret": false },
        "ACTIONS_RESULTS_URL": { "Value": format!("{base}/"), "IsSecret": false },
        "GITHUB_SERVER_URL": { "Value": "https://github.com", "IsSecret": false },
        "GITHUB_REF_NAME": { "Value": "main", "IsSecret": false },
        "GITHUB_WORKFLOW": { "Value": workflow_name, "IsSecret": false },
        "GITHUB_WORKSPACE": { "Value": workspace_path, "IsSecret": false },
        "system.github.token": { "Value": "fake-token", "IsSecret": true },
        "system.github.job": { "Value": "local-job", "IsSecret": false },
        "system.github.repository": { "Value": repo_full_name, "IsSecret": false },
        "github.repository": { "Value": repo_full_name, "IsSecret": false },
        "github.actor": { "Value": owner_name, "IsSecret": false },
        "github.sha": { "Value": real_head_sha, "IsSecret": false },
        "github.ref": { "Value": "refs/heads/main", "IsSecret": false },
        "repository": { "Value": repo_full_name, "IsSecret": false },
        "GITHUB_REPOSITORY": { "Value": repo_full_name, "IsSecret": false },
        "GITHUB_ACTOR": { "Value": owner_name, "IsSecret": false },
        "GITHUB_SHA": { "Value": real_head_sha, "IsSecret": false },
        "build.repository.name": { "Value": repo_full_name, "IsSecret": false },
        "build.repository.uri": { "Value": format!("https://github.com/{repo_full_name}"), "IsSecret": false }
    });
    if let Some(object) = variables.as_object_mut() {
        for (key, value) in &context_env {
            object.insert(key.clone(), json!({ "Value": value, "IsSecret": false }));
        }
    }

    let github_context = json!({
        "repository": repo_full_name,
        "actor": owner_name,
        "sha": real_head_sha,
        "ref": "refs/heads/main",
        "event_name": "push",
        "server_url": "https://github.com",
        "api_url": base,
        "graphql_url": format!("{base}/_graphql"),
        "workspace": workspace_path,
        "action": "__run",
        "token": "fake-token",
        "job": "local-job",
        "event": {
            "repository": {
                "full_name": repo_full_name,
                "name": repo_name,
                "owner": { "login": owner_name },
                "default_branch": "main"
            },
            "before": "0000000000000000000000000000000000000000",
            "after": real_head_sha
        }
    });

    let raw_matrix_context = job_data.get("matrix");
    let matrix_context = matrix_context_value(raw_matrix_context);
    let strategy_context = strategy_context_value(raw_matrix_context);
    let environment_variables = if job_env.is_empty() {
        Value::Array(Vec::new())
    } else {
        json!([to_template_token_mapping(&json!(job_env))])
    };
    let env_context = if context_env.is_empty() {
        None
    } else {
        Some(to_context_data(&json!(context_env)))
    };

    let empty_object = json!({});
    let needs_value = job_data.get("needs").unwrap_or(&empty_object);
    let outputs_value = job_data.get("outputs").unwrap_or(&empty_object);

    let mut context_data = serde_json::Map::new();
    context_data.insert("github".to_owned(), to_context_data(&github_context));
    context_data.insert("steps".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("needs".to_owned(), to_context_data(needs_value));
    context_data.insert("strategy".to_owned(), to_context_data(&strategy_context));
    context_data.insert("matrix".to_owned(), to_context_data(&matrix_context));
    context_data.insert("secrets".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("vars".to_owned(), json!({ "t": 2, "d": [] }));
    context_data.insert("inputs".to_owned(), json!({ "t": 2, "d": [] }));
    if let Some(env_context) = env_context {
        context_data.insert("env".to_owned(), env_context);
    }

    let mut body = json!({
        "MessageType": "PipelineAgentJobRequest",
        "Plan": { "PlanId": plan_id, "PlanType": "Action", "ScopeId": mock_uuid(state.next_id()) },
        "Timeline": { "Id": timeline_id, "ChangeId": 1 },
        "JobId": generated_job_id,
        "RequestId": job_id.parse::<u64>().unwrap_or(1),
        "JobDisplayName": job_name,
        "JobName": job_name,
        "Steps": map_job_steps(job_data.get("steps"), &base),
        "Variables": variables,
        "ContextData": Value::Object(context_data),
        "Resources": {
            "Repositories": [{
                "Alias": "self",
                "Id": "repo-1",
                "Type": "git",
                "Version": string_field(job_data, &["headSha"]).unwrap_or_else(|| "HEAD".to_owned()),
                "Url": format!("https://github.com/{repo_full_name}"),
                "Properties": {
                    "id": "repo-1",
                    "name": repo_name,
                    "fullName": repo_full_name,
                    "repoFullName": repo_full_name,
                    "owner": owner_name,
                    "defaultBranch": "main",
                    "cloneUrl": format!("https://github.com/{repo_full_name}.git")
                }
            }],
            "Endpoints": [{
                "Name": "SystemVssConnection",
                "Url": base,
                "Authorization": { "Parameters": { "AccessToken": mock_token }, "Scheme": "OAuth" }
            }]
        },
        "Workspace": { "Path": workspace_path },
        "SystemVssConnection": {
            "Url": base,
            "Authorization": { "Parameters": { "AccessToken": mock_token }, "Scheme": "OAuth" }
        },
        "Actions": [],
        "MaskHints": [],
        "EnvironmentVariables": environment_variables,
        "JobOutputs": to_template_token_mapping(outputs_value)
    });
    if let Some(container) = job_data.get("container").and_then(job_container_token) {
        body["JobContainer"] = container;
    }
    if let Some(services) = job_data
        .get("services")
        .and_then(Value::as_array)
        .filter(|services| !services.is_empty())
        .map(|services| job_service_containers_token(services))
    {
        body["JobServiceContainers"] = services;
    }
    json!({
        "MessageId": 1,
        "MessageType": "PipelineAgentJobRequest",
        "Body": body.to_string(),
        "body": body.to_string(),
        "baseUrl": base
    })
}

fn mock_uuid(id: u64) -> String {
    format!(
        "00000000-0000-4000-8000-{tail:012x}",
        tail = id & 0x0000_ffff_ffff_ffff
    )
}

fn create_mock_jwt(plan_id: &str, job_id: &str) -> String {
    let payload = format!("{{\"orchid\":\"123\",\"scp\":\"Actions.Results:{plan_id}:{job_id}\"}}");
    format!(
        "{}.{}.mock-signature",
        base64_url(r#"{"alg":"HS256","typ":"JWT"}"#.as_bytes()),
        base64_url(payload.as_bytes())
    )
}

fn base64_url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        }
    }
    out
}

fn map_job_steps(steps: Option<&Value>, base_url: &str) -> Value {
    Value::Array(
        steps
            .and_then(Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .enumerate()
                    .map(|(index, step)| map_job_step(step, index, base_url))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    )
}

fn map_job_step(step: &Value, index: usize, base_url: &str) -> Value {
    let name = string_field(step, &["Name", "name"]).unwrap_or_else(|| format!("step-{index}"));
    let display_name =
        string_field(step, &["DisplayName", "Name", "name"]).unwrap_or_else(|| name.clone());
    let inputs = step
        .get("Inputs")
        .cloned()
        .or_else(|| step.get("inputs").cloned())
        .or_else(|| {
            step.get("run")
                .and_then(Value::as_str)
                .map(|run| json!({ "script": run }))
        })
        .unwrap_or_else(|| json!({}));
    let condition =
        string_field(step, &["condition", "Condition"]).unwrap_or_else(|| "success()".to_owned());
    let mut mapped = json!({
        "id": string_field(step, &["Id", "id"]).unwrap_or_else(|| mock_uuid(index as u64 + 1)),
        "name": name,
        "displayName": display_name,
        "type": string_field(step, &["Type", "type"]).unwrap_or_else(|| "Action".to_owned()).to_ascii_lowercase(),
        "reference": map_step_reference(
            step.get("Reference").or_else(|| step.get("reference")),
            step.get("uses").and_then(Value::as_str),
        ),
        "inputs": to_template_token_mapping(&inputs),
        "contextData": json!({ "t": 2, "d": [] }),
        "condition": condition,
    });
    if let Some(context_name) = string_field(step, &["ContextName", "contextName"]) {
        mapped["contextName"] = Value::String(context_name);
    }
    let mut step_env = step.get("Env").cloned().unwrap_or_else(|| json!({}));
    if !step_env.is_object() {
        step_env = json!({});
    }
    if let Some(env) = step_env.as_object_mut() {
        env.entry("ACTIONS_CACHE_URL".to_owned())
            .or_insert_with(|| Value::String(format!("{base_url}/")));
        env.entry("ACTIONS_RESULTS_URL".to_owned())
            .or_insert_with(|| Value::String(format!("{base_url}/")));
    }
    mapped["environment"] = to_template_token_mapping(&step_env);
    mapped
}

fn map_step_reference(reference: Option<&Value>, uses: Option<&str>) -> Value {
    if reference.is_none()
        && let Some(uses) = uses
    {
        return map_uses_reference(uses);
    }

    let reference_type = reference
        .and_then(|value| value.get("Type").or_else(|| value.get("type")))
        .and_then(Value::as_str)
        .unwrap_or("Script")
        .to_ascii_lowercase();
    let type_id = match reference_type.as_str() {
        "repository" => 1,
        "container" => 2,
        _ => 3,
    };
    if type_id == 1 {
        json!({
            "type": type_id,
            "name": reference.and_then(|value| value.get("Name")).and_then(Value::as_str).unwrap_or(""),
            "ref": reference.and_then(|value| value.get("Ref")).and_then(Value::as_str).unwrap_or(""),
            "repositoryType": reference.and_then(|value| value.get("RepositoryType")).and_then(Value::as_str).unwrap_or("GitHub"),
            "path": reference.and_then(|value| value.get("Path")).and_then(Value::as_str).unwrap_or(""),
        })
    } else {
        json!({ "type": type_id })
    }
}

fn map_uses_reference(uses: &str) -> Value {
    if uses.starts_with("./") {
        return json!({
            "type": 1,
            "name": "",
            "ref": "",
            "repositoryType": "self",
            "path": uses,
        });
    }

    let Some((raw_name, reference)) = uses.rsplit_once('@') else {
        return json!({ "type": 3 });
    };
    let mut parts = raw_name.split('/').collect::<Vec<_>>();
    if parts.len() < 2 {
        return json!({ "type": 3 });
    }
    let name = format!("{}/{}", parts[0], parts[1]);
    let path = if parts.len() > 2 {
        parts.drain(2..).collect::<Vec<_>>().join("/")
    } else {
        String::new()
    };
    json!({
        "type": 1,
        "name": name,
        "ref": reference,
        "repositoryType": "GitHub",
        "path": path,
    })
}

fn job_service_containers_token(services: &[Value]) -> Value {
    json!({
        "type": 2,
        "map": services
            .iter()
            .filter_map(|service| {
                let id = service.get("id").and_then(Value::as_str)?;
                let container = job_container_token(service)?;
                Some(json!({ "Key": id, "Value": container }))
            })
            .collect::<Vec<_>>()
    })
}

fn job_container_token(container: &Value) -> Option<Value> {
    let image = container.get("image").and_then(Value::as_str)?;
    let mut entries = vec![json!({ "Key": "image", "Value": image })];
    if let Some(options) = container.get("options").and_then(Value::as_str) {
        if !options.trim().is_empty() {
            entries.push(json!({ "Key": "options", "Value": options }));
        }
    }
    if let Some(env) = container.get("env").filter(|env| env.is_object()) {
        entries.push(json!({ "Key": "env", "Value": to_template_token_mapping(env) }));
    }
    if let Some(ports) = template_sequence_token(container.get("ports")) {
        entries.push(json!({ "Key": "ports", "Value": ports }));
    }
    if let Some(volumes) = template_sequence_token(container.get("volumes")) {
        entries.push(json!({ "Key": "volumes", "Value": volumes }));
    }
    Some(json!({ "type": 2, "map": entries }))
}

fn template_sequence_token(value: Option<&Value>) -> Option<Value> {
    let items = value?.as_array()?;
    if items.is_empty() {
        return None;
    }
    let strings = items.iter().map(value_to_string).collect::<Vec<_>>();
    Some(template_sequence_from_strings(&strings))
}

fn template_sequence_from_strings(items: &[String]) -> Value {
    json!({
        "type": 1,
        "seq": items.iter().map(|item| Value::String(item.clone())).collect::<Vec<_>>()
    })
}

fn string_map_from_value(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value_to_string(value)))
                .collect()
        })
        .unwrap_or_default()
}

fn matrix_context_value(value: Option<&Value>) -> Value {
    let object = value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| !key.starts_with("__job_"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    Value::Object(object)
}

fn strategy_context_value(matrix: Option<&Value>) -> Value {
    let job_index = matrix
        .and_then(|matrix| matrix.get("__job_index"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let job_total = matrix
        .and_then(|matrix| matrix.get("__job_total"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1);
    json!({ "job-index": job_index, "job-total": job_total })
}

fn to_context_data(value: &Value) -> Value {
    match value {
        Value::String(value) => json!({ "t": 0, "s": value }),
        Value::Bool(value) => json!({ "t": 3, "b": value }),
        Value::Number(value) => json!({ "t": 4, "n": value }),
        Value::Array(items) => {
            json!({ "t": 1, "a": items.iter().map(to_context_data).collect::<Vec<_>>() })
        }
        Value::Object(map) => json!({
            "t": 2,
            "d": map.iter().map(|(key, value)| json!({ "k": key, "v": to_context_data(value) })).collect::<Vec<_>>()
        }),
        Value::Null => json!({ "t": 0, "s": "" }),
    }
}

fn to_template_token_mapping(value: &Value) -> Value {
    let entries = value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| json!({ "Key": key, "Value": to_template_token_value(&value_to_string(value)) }))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if entries.is_empty() {
        json!({ "type": 2 })
    } else {
        json!({ "type": 2, "map": entries })
    }
}

fn to_template_token_value(value: &str) -> Value {
    let trimmed = value.trim();
    if let Some(expr) = trimmed
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
    {
        return json!({ "type": 3, "expr": expr.trim() });
    }
    Value::String(value.to_owned())
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

fn append_log_lines(request: &Request, state: &DtuState, plan_id: &str, log_id: &str) {
    let payload = request_json(request);
    let lines = payload
        .get("value")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(feed_line_to_string).collect())
        .unwrap_or_default();
    write_step_output_lines(state, plan_id, log_id, lines);
}

fn append_timeline_feed(request: &Request, state: &DtuState, plan_id: &str, record_id: &str) {
    let payload = request_json(request);
    let lines = if let Some(values) = payload.get("value").and_then(Value::as_array) {
        values.iter().filter_map(feed_line_to_string).collect()
    } else if let Some(values) = payload.as_array() {
        values.iter().filter_map(feed_line_to_string).collect()
    } else {
        Vec::new()
    };
    write_step_output_lines(state, plan_id, record_id, lines);
}

fn feed_line_to_string(value: &Value) -> Option<String> {
    if let Some(line) = value.as_str() {
        return Some(line.to_owned());
    }
    value
        .get("message")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| Some(value.to_string()))
}

fn write_step_output_lines(state: &DtuState, plan_id: &str, record_id: &str, lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    let Some(log_dir) = state
        .plan_to_log_dir
        .lock()
        .expect("plan log lock")
        .get(plan_id)
        .cloned()
    else {
        return;
    };

    let mut content = String::new();
    let mut in_group = false;
    let mut output_entries = Vec::<(String, String)>::new();
    for raw_line in lines {
        let line = raw_line.trim_end();
        if line.is_empty() {
            if !in_group {
                content.push('\n');
            }
            continue;
        }
        let stripped = strip_runner_line_prefix(line);
        if let Some(kv) = stripped.strip_prefix("::agent-ci-output::") {
            if let Some((key, value)) = kv.split_once('=')
                && !key.is_empty()
            {
                output_entries.push((key.to_owned(), value.to_owned()));
            }
            continue;
        }
        if stripped.starts_with("##[group]") {
            in_group = true;
            continue;
        }
        if stripped.starts_with("##[endgroup]") {
            in_group = false;
            continue;
        }
        if in_group
            || stripped.is_empty()
            || stripped.starts_with("##[")
            || stripped.starts_with("[command]")
            || is_runner_internal_line(stripped)
        {
            continue;
        }
        content.push_str(stripped);
        content.push('\n');
    }

    if !output_entries.is_empty() {
        persist_agent_ci_outputs(&PathBuf::from(&log_dir), output_entries);
    }

    if content.is_empty() {
        return;
    }
    let step_name = state
        .record_to_step_name
        .lock()
        .expect("record step lock")
        .get(record_id)
        .cloned()
        .or_else(|| current_step_for_plan(state, &log_dir))
        .unwrap_or_else(|| sanitize_step_log_name(record_id));
    let steps_dir = PathBuf::from(log_dir).join("steps");
    let _ = fs::create_dir_all(&steps_dir);
    let path = steps_dir.join(format!("{step_name}.log"));
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, content.as_bytes()));
}

fn persist_agent_ci_outputs(log_dir: &Path, entries: Vec<(String, String)>) {
    let path = log_dir.join("outputs.json");
    let mut existing = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
        .unwrap_or_default();
    for (key, value) in entries {
        existing.insert(key, value);
    }
    if let Ok(data) = serde_json::to_vec_pretty(&existing) {
        let _ = fs::write(path, data);
    }
}

fn current_step_for_plan(state: &DtuState, log_dir: &str) -> Option<String> {
    let timeline_ids = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .iter()
        .filter_map(|(timeline_id, mapped_log_dir)| {
            (mapped_log_dir == log_dir).then_some(timeline_id.clone())
        })
        .collect::<Vec<_>>();
    let current = state
        .current_in_progress_step
        .lock()
        .expect("current step lock");
    timeline_ids
        .iter()
        .find_map(|timeline_id| current.get(timeline_id).cloned())
}

fn strip_runner_line_prefix(line: &str) -> &str {
    let stripped = line.trim_start_matches('\u{feff}');
    if stripped.len() > 22
        && stripped.as_bytes().get(4) == Some(&b'-')
        && stripped.as_bytes().get(7) == Some(&b'-')
        && stripped.as_bytes().get(10) == Some(&b'T')
        && let Some(index) = stripped.find("Z ")
    {
        return stripped[index + 2..].trim_start_matches('\u{feff}');
    }
    stripped
}

fn is_runner_internal_line(line: &str) -> bool {
    (line.starts_with("[RUNNER ") || line.starts_with("[WORKER "))
        && (line.contains(" INFO ") || line.contains(" WARN ") || line.contains(" ERR "))
}

fn update_step_log_mappings(state: &DtuState, timeline_id: &str, log_dir: &str, records: &[Value]) {
    let steps_dir = PathBuf::from(log_dir).join("steps");
    let mut record_map = state.record_to_step_name.lock().expect("record step lock");
    let mut current_map = state
        .current_in_progress_step
        .lock()
        .expect("current step lock");
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("Task") {
            continue;
        }
        let Some(name) = record.get("name").and_then(Value::as_str) else {
            continue;
        };
        let sanitized = sanitize_step_log_name(name);
        let mut ids = Vec::<String>::new();
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            ids.push(id.to_owned());
        }
        if let Some(id) = record
            .get("log")
            .and_then(|log| log.get("id"))
            .and_then(|id| {
                id.as_str()
                    .map(ToOwned::to_owned)
                    .or_else(|| id.as_u64().map(|id| id.to_string()))
            })
        {
            ids.push(id);
        }
        if is_user_step_record(record)
            && let Some(parent_id) = record.get("parentId").and_then(Value::as_str)
        {
            ids.push(parent_id.to_owned());
        }
        for id in ids {
            let old_path = steps_dir.join(format!("{id}.log"));
            let new_path = steps_dir.join(format!("{sanitized}.log"));
            if old_path.exists() && !new_path.exists() {
                let _ = fs::rename(&old_path, &new_path);
            }
            record_map.insert(id, sanitized.clone());
        }
        if record
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| state.eq_ignore_ascii_case("inProgress"))
        {
            current_map.insert(timeline_id.to_owned(), sanitized);
        }
    }
}

fn is_user_step_record(record: &Value) -> bool {
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let ref_name = record
        .get("refName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    !matches!(name, "Set up job" | "Complete job")
        && !matches!(ref_name, "JobExtension_Init" | "JobExtension_Final")
}

fn sanitize_step_log_name(name: &str) -> String {
    let mut result = String::new();
    let mut previous_dash = false;
    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            ch
        } else {
            '-'
        };
        if mapped == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        result.push(mapped);
        if result.len() >= 80 {
            break;
        }
    }
    result.trim_matches('-').to_owned()
}

fn timeline_records(request: &Request, state: &DtuState, timeline_id: &str) -> Response {
    let payload = request_json(request);
    let records = payload
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(log_dir) = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .get(timeline_id)
        .cloned()
    {
        let file = PathBuf::from(&log_dir).join("timeline.json");
        let _ = fs::write(
            file,
            serde_json::to_vec_pretty(&records).unwrap_or_default(),
        );
        update_step_log_mappings(state, timeline_id, &log_dir, &records);
    }
    Response::json(200, json!({ "count": records.len(), "value": records }))
}

fn timeline_get(state: &DtuState, timeline_id: &str) -> Response {
    let records = state
        .timeline_to_log_dir
        .lock()
        .expect("timeline lock")
        .get(timeline_id)
        .and_then(|log_dir| fs::read_to_string(PathBuf::from(log_dir).join("timeline.json")).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!([]));
    Response::json(200, json!({ "id": timeline_id, "records": records }))
}

fn route_cache(request: &Request, state: &DtuState, segments: &[&str]) -> Option<Response> {
    if request.method == "GET"
        && (request.path == "/_apis/artifactcache/caches"
            || request.path == "/_apis/artifactcache/cache")
    {
        return Some(cache_lookup(request, state));
    }
    if request.method == "POST" && segments == ["_apis", "artifactcache", "caches"] {
        return Some(cache_reserve(request, state));
    }
    if segments.len() == 4 && segments[0..3] == ["_apis", "artifactcache", "caches"] {
        let cache_id = segments[3].parse::<u64>().unwrap_or(u64::MAX);
        if request.method == "PATCH" {
            return Some(cache_upload(request, state, cache_id));
        }
        if request.method == "POST" {
            return Some(cache_commit(request, state, cache_id));
        }
    }
    if request.method == "GET"
        && segments.len() == 4
        && segments[0..3] == ["_apis", "artifactcache", "artifacts"]
    {
        return Some(cache_download(
            state,
            segments[3].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    None
}

fn cache_lookup(request: &Request, state: &DtuState) -> Response {
    let keys = request
        .query
        .get("keys")
        .map(|keys| {
            keys.split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let version = request.query.get("version").cloned().unwrap_or_default();
    for key in keys {
        if state.is_virtual_cache_key(key) {
            return Response::json(
                200,
                json!({ "result": "hit", "archiveLocation": format!("{}/_apis/artifactcache/artifacts/{VIRTUAL_CACHE_ID}", base_url(request)), "cacheKey": key }),
            );
        }
        let lookup = {
            let mut caches = state.caches.lock().expect("caches lock");
            if let Some(entry) = caches.get(key).cloned() {
                if entry.version != version {
                    None
                } else if let Some(cache_id) =
                    cache_id_from_archive_location(&entry.archive_location)
                {
                    if state
                        .cache_dir
                        .join(format!("cache_{cache_id}.tar.gz"))
                        .exists()
                    {
                        Some((cache_id, entry))
                    } else {
                        caches.remove(key);
                        drop(caches);
                        save_caches_to_disk(state);
                        None
                    }
                } else {
                    Some((0, entry))
                }
            } else {
                None
            }
        };
        if let Some((cache_id, entry)) = lookup {
            let archive_location = if cache_id == 0 {
                entry.archive_location
            } else {
                format!(
                    "{}/_apis/artifactcache/artifacts/{cache_id}",
                    base_url(request)
                )
            };
            return Response::json(
                200,
                json!({ "result": "hit", "archiveLocation": archive_location, "cacheKey": key }),
            );
        }
    }
    Response::empty(204)
}

fn cache_reserve(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let key = payload.get("key").map(value_to_string).unwrap_or_default();
    let version = payload
        .get("version")
        .map(value_to_string)
        .unwrap_or_default();
    if state.is_virtual_cache_key(&key) {
        return Response::json(201, json!({ "cacheId": VIRTUAL_CACHE_ID }));
    }
    if state
        .caches
        .lock()
        .expect("caches lock")
        .get(&key)
        .is_some_and(|entry| entry.version == version)
    {
        return Response::json(409, json!({ "message": "Cache already exists" }));
    }
    let cache_id = state.next_id();
    let temp_path = state.cache_dir.join(format!("temp_{cache_id}.tar.gz"));
    let _ = fs::write(&temp_path, []);
    state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .insert(
            cache_id,
            PendingCache {
                temp_path,
                key,
                version,
            },
        );
    Response::json(201, json!({ "cacheId": cache_id }))
}

fn cache_upload(request: &Request, state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return Response::empty(200);
    }
    let Some(pending) = state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .get(&cache_id)
        .cloned()
    else {
        return Response::empty(404);
    };
    let start = request
        .headers
        .get("content-range")
        .and_then(|range| range.strip_prefix("bytes "))
        .and_then(|range| range.split('-').next())
        .and_then(|start| start.parse::<u64>().ok());
    let result = if let Some(start) = start {
        fs::OpenOptions::new()
            .write(true)
            .open(&pending.temp_path)
            .and_then(|mut file| {
                use std::io::Seek;
                file.seek(std::io::SeekFrom::Start(start))?;
                file.write_all(&request.body)
            })
    } else {
        fs::OpenOptions::new()
            .append(true)
            .open(&pending.temp_path)
            .and_then(|mut file| file.write_all(&request.body))
    };
    if result.is_ok() {
        Response::empty(200)
    } else {
        Response::empty(500)
    }
}

fn cache_commit(request: &Request, state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return Response::empty(200);
    }
    let Some(pending) = state
        .pending_caches
        .lock()
        .expect("pending cache lock")
        .remove(&cache_id)
    else {
        return Response::empty(404);
    };
    let final_path = state.cache_dir.join(format!("cache_{cache_id}.tar.gz"));
    if fs::rename(&pending.temp_path, &final_path).is_err() {
        return Response::empty(500);
    }
    let size = request_json(request)
        .get("size")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let archive_location = format!(
        "{}/_apis/artifactcache/artifacts/{cache_id}",
        base_url(request)
    );
    state.caches.lock().expect("caches lock").insert(
        pending.key,
        CacheEntry {
            version: pending.version,
            archive_location,
            size,
        },
    );
    save_caches_to_disk(state);
    Response::empty(200)
}

fn cache_download(state: &DtuState, cache_id: u64) -> Response {
    if cache_id == VIRTUAL_CACHE_ID {
        return fs::read(empty_tar_gz_path(state)).map_or_else(
            |_| Response::empty(500),
            |bytes| Response::bytes(200, "application/octet-stream", bytes),
        );
    }
    let path = state.cache_dir.join(format!("cache_{cache_id}.tar.gz"));
    fs::read(path).map_or_else(
        |_| Response::empty(404),
        |bytes| Response::bytes(200, "application/octet-stream", bytes),
    )
}

fn empty_tar_gz_path(state: &DtuState) -> PathBuf {
    let path = state.cache_dir.join("__empty__.tar.gz");
    if path.exists() {
        return path;
    }
    let _ = fs::create_dir_all(&state.cache_dir);
    let _ = std::process::Command::new("tar")
        .arg("-czf")
        .arg(&path)
        .arg("-T")
        .arg("/dev/null")
        .status();
    path
}

fn route_artifacts(request: &Request, state: &DtuState, segments: &[&str]) -> Option<Response> {
    if request.method == "POST" && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/CreateArtifact")
    {
        return Some(twirp_create_artifact(request, state));
    }
    if request.method == "POST"
        && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/FinalizeArtifact")
    {
        return Some(twirp_finalize_artifact(request, state));
    }
    if request.method == "POST" && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/ListArtifacts")
    {
        return Some(twirp_list_artifacts(request, state));
    }
    if request.method == "POST"
        && request.path == format!("{TWIRP_ARTIFACT_PREFIX}/GetSignedArtifactURL")
    {
        return Some(twirp_signed_artifact_url(request, state));
    }
    if segments.len() == 4 && segments[0..2] == ["_apis", "artifactblob"] {
        let container_id = segments[2].parse::<u64>().unwrap_or(u64::MAX);
        if request.method == "PUT" && segments[3] == "upload" {
            return Some(blob_upload(request, state, container_id));
        }
        if request.method == "GET" && segments[3] == "download" {
            return Some(blob_download(state, container_id));
        }
    }
    if request.method == "POST" && request.path == "/_apis/artifacts" {
        return Some(rest_create_artifact(request, state));
    }
    if request.method == "PUT" && segments.len() == 3 && segments[0..2] == ["_apis", "artifacts"] {
        return Some(rest_upload_artifact(
            request,
            state,
            segments[2].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    if request.method == "PATCH" && request.path == "/_apis/artifacts" {
        return Some(rest_finalize_artifact(request, state));
    }
    if request.method == "GET" && request.path == "/_apis/artifacts" {
        return Some(rest_list_artifacts(request, state));
    }
    if request.method == "GET"
        && segments.len() == 3
        && segments[0..2] == ["_apis", "artifactfiles"]
    {
        return Some(rest_download_artifact(
            state,
            segments[2].parse::<u64>().unwrap_or(u64::MAX),
        ));
    }
    None
}

fn twirp_create_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "msg": "Missing artifact name" }));
    };
    let container_id = state.next_id();
    state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock")
        .insert(
            container_id,
            PendingArtifact {
                name: name.to_owned(),
                files: BTreeMap::new(),
            },
        );
    Response::json(
        200,
        json!({ "ok": true, "signedUploadUrl": format!("{}/_apis/artifactblob/{container_id}/upload", base_url(request)) }),
    )
}

fn twirp_finalize_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "msg": "Missing artifact name" }));
    };
    finalize_artifact_by_name(state, name).map_or_else(
        || Response::json(404, json!({ "ok": false })),
        |container_id| {
            Response::json(
                200,
                json!({ "ok": true, "artifactId": container_id.to_string() }),
            )
        },
    )
}

fn twirp_list_artifacts(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let filter_name = payload.get("nameFilter").and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("value").and_then(Value::as_str))
    });
    let artifacts = state.artifacts.lock().expect("artifacts lock").iter().filter_map(|(name, artifact)| {
        if filter_name.is_some_and(|filter| filter != name) {
            return None;
        }
        Some(json!({
            "workflowRunBackendId": "00000000-0000-0000-0000-000000000001",
            "databaseId": artifact.container_id.to_string(),
            "name": name,
            "size": artifact.files.values().next().and_then(|path| fs::metadata(path).ok()).map_or(0, |meta| meta.len()).to_string(),
            "createdAt": iso_now()
        }))
    }).collect::<Vec<_>>();
    Response::json(200, json!({ "artifacts": artifacts }))
}

fn twirp_signed_artifact_url(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(404, json!({ "signedUrl": "" }));
    };
    let artifact = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .get(name)
        .cloned();
    artifact.map_or_else(
        || Response::json(404, json!({ "signedUrl": "" })),
        |artifact| Response::json(200, json!({ "signedUrl": format!("{}/_apis/artifactblob/{}/download", base_url(request), artifact.container_id) })),
    )
}

fn blob_upload(request: &Request, state: &DtuState, container_id: u64) -> Response {
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let Some(artifact) = pending.get_mut(&container_id) else {
        return Response::empty(404);
    };
    if request
        .query
        .get("comp")
        .is_some_and(|comp| comp == "block")
    {
        let block_id = request.query.get("blockid").cloned().unwrap_or_default();
        state
            .artifact_blocks
            .lock()
            .expect("blocks lock")
            .entry(container_id)
            .or_default()
            .insert(block_id, request.body.clone());
        return Response::empty(201);
    }
    if request
        .query
        .get("comp")
        .is_some_and(|comp| comp == "blocklist")
    {
        let xml = String::from_utf8_lossy(&request.body);
        let ids = latest_block_ids(&xml);
        let blocks = state
            .artifact_blocks
            .lock()
            .expect("blocks lock")
            .remove(&container_id)
            .unwrap_or_default();
        let bytes = if ids.is_empty() {
            blocks.values().flatten().copied().collect()
        } else {
            ids.iter()
                .flat_map(|id| blocks.get(id).cloned().unwrap_or_default())
                .collect()
        };
        return write_artifact_blob(state, artifact, container_id, bytes);
    }
    write_artifact_blob(state, artifact, container_id, request.body.clone())
}

fn write_artifact_blob(
    state: &DtuState,
    artifact: &mut PendingArtifact,
    container_id: u64,
    bytes: Vec<u8>,
) -> Response {
    let path = state
        .cache_dir
        .join("artifacts")
        .join(format!("{container_id}_blob.zip"));
    if fs::write(&path, bytes).is_err() {
        return Response::empty(500);
    }
    artifact.files.insert("artifact.zip".to_owned(), path);
    Response::json(201, json!({ "ok": true }))
}

fn latest_block_ids(xml: &str) -> Vec<String> {
    xml.split("<Latest>")
        .skip(1)
        .filter_map(|part| part.split("</Latest>").next())
        .map(ToOwned::to_owned)
        .collect()
}

fn blob_download(state: &DtuState, container_id: u64) -> Response {
    let path = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .values()
        .find(|artifact| artifact.container_id == container_id)
        .and_then(|artifact| artifact.files.values().next().cloned());
    path.and_then(|path| fs::read(path).ok()).map_or_else(
        || Response::empty(404),
        |bytes| Response::bytes(200, "application/zip", bytes),
    )
}

fn rest_create_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return Response::json(400, json!({ "error": "Missing artifact name" }));
    };
    let container_id = state.next_id();
    state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock")
        .insert(
            container_id,
            PendingArtifact {
                name: name.to_owned(),
                files: BTreeMap::new(),
            },
        );
    Response::json(
        201,
        json!({ "containerId": container_id, "name": name, "fileContainerResourceUrl": format!("{}/_apis/artifacts/{container_id}", base_url(request)) }),
    )
}

fn rest_upload_artifact(request: &Request, state: &DtuState, container_id: u64) -> Response {
    let item_path = request
        .query
        .get("itemPath")
        .cloned()
        .unwrap_or_else(|| "artifact.bin".to_owned());
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let Some(artifact) = pending.get_mut(&container_id) else {
        return Response::empty(404);
    };
    let path = state.cache_dir.join("artifacts").join(format!(
        "{}_{}",
        container_id,
        Path::new(&item_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ));
    if fs::write(&path, &request.body).is_err() {
        return Response::empty(500);
    }
    artifact.files.insert(item_path, path);
    Response::json(200, json!({ "ok": true }))
}

fn rest_finalize_artifact(request: &Request, state: &DtuState) -> Response {
    let payload = request_json(request);
    let Some(name) = payload.get("artifactName").and_then(Value::as_str) else {
        return Response::json(400, json!({ "error": "Missing artifactName" }));
    };
    finalize_artifact_by_name(state, name).map_or_else(
        || Response::empty(404),
        |container_id| Response::json(200, json!({ "ok": true, "containerId": container_id })),
    )
}

fn finalize_artifact_by_name(state: &DtuState, name: &str) -> Option<u64> {
    let mut pending = state
        .pending_artifacts
        .lock()
        .expect("pending artifacts lock");
    let container_id = pending
        .iter()
        .find(|(_, pending)| pending.name == name)
        .map(|(id, _)| *id)?;
    let pending_artifact = pending.remove(&container_id)?;
    state.artifacts.lock().expect("artifacts lock").insert(
        name.to_owned(),
        Artifact {
            container_id,
            files: pending_artifact.files,
        },
    );
    Some(container_id)
}

fn rest_list_artifacts(request: &Request, state: &DtuState) -> Response {
    let filter = request.query.get("artifactName").map(String::as_str);
    let value = state.artifacts.lock().expect("artifacts lock").iter().filter_map(|(name, artifact)| {
        if filter.is_some_and(|filter| filter != name) {
            return None;
        }
        Some(json!({ "containerId": artifact.container_id, "name": name, "fileContainerResourceUrl": format!("{}/_apis/artifactfiles/{}", base_url(request), artifact.container_id) }))
    }).collect::<Vec<_>>();
    Response::json(200, json!({ "count": value.len(), "value": value }))
}

fn rest_download_artifact(state: &DtuState, container_id: u64) -> Response {
    let path = state
        .artifacts
        .lock()
        .expect("artifacts lock")
        .values()
        .find(|artifact| artifact.container_id == container_id)
        .and_then(|artifact| artifact.files.values().next().cloned());
    path.and_then(|path| fs::read(path).ok()).map_or_else(
        || Response::empty(404),
        |bytes| Response::bytes(200, "application/octet-stream", bytes),
    )
}

fn base_url(request: &Request) -> String {
    let host = request
        .headers
        .get("host")
        .map(String::as_str)
        .unwrap_or("localhost");
    let protocol = request
        .headers
        .get("x-forwarded-proto")
        .map(String::as_str)
        .unwrap_or("http");
    format!("{protocol}://{host}")
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn iso_now() -> String {
    iso_from_millis(now_ms() as u64)
}

fn iso_now_plus_hour() -> String {
    iso_from_millis(now_ms() as u64 + 60 * 60 * 1000)
}

fn iso_now_plus_minute() -> String {
    iso_from_millis(now_ms() as u64 + 60 * 1000)
}

fn iso_from_millis(millis: u64) -> String {
    let seconds = millis / 1000;
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(seconds);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z",
        ms = millis % 1000
    )
}

fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-dtu-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(
        server: &EphemeralDtu,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> (u16, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        let body = body.unwrap_or_default();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            server.port,
            body.len()
        )
        .unwrap();
        stream.write_all(body).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        parse_response(&response)
    }

    fn json_request(server: &EphemeralDtu, method: &str, path: &str, body: Value) -> (u16, Value) {
        let bytes = serde_json::to_vec(&body).unwrap();
        let (status, body) = request(server, method, path, Some(&bytes));
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    fn parse_response(response: &[u8]) -> (u16, Vec<u8>) {
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&response[..split]);
        let status = head
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, response[split + 4..].to_vec())
    }

    #[test]
    fn starts_ephemeral_server_and_closes_cleanly() {
        let server = start_ephemeral_dtu(temp_dir("start"), Some("container.local")).unwrap();

        assert!(server.url.starts_with("http://127.0.0.1:"));
        assert!(server.container_url.starts_with("http://container.local:"));
        let (status, body) = request(&server, "GET", "/_dtu/dump", None);
        assert_eq!(status, 200);
        assert!(String::from_utf8(body).unwrap().contains("runnerLogs"));

        server.close();
    }

    #[test]
    fn http_client_registers_runner_and_seeds_targeted_job() {
        let server = start_ephemeral_dtu(temp_dir("client"), None).unwrap();
        let mut client = DtuHttpClient::new(&server.url);
        let log_dir = temp_dir("client-logs");

        client
            .register_runner(&DtuRunnerRegistration {
                runner_name: "runner-a".to_owned(),
                log_dir: log_dir.clone(),
                timeline_dir: log_dir.clone(),
                virtual_cache_patterns: vec!["pnpm".to_owned()],
            })
            .unwrap();
        client
            .seed_job(&DtuJobSeed {
                id: "job-1".to_owned(),
                runner_name: "runner-a".to_owned(),
                name: "test".to_owned(),
                workflow_name: "ci".to_owned(),
                repo_root: temp_dir("client-repo"),
                github_repo: "owner/repo".to_owned(),
                head_sha: "HEAD".to_owned(),
                real_head_sha: "abc123".to_owned(),
                runner_work_dir: None,
                runner_os: None,
                runner_arch: None,
                env: BTreeMap::new(),
                outputs: BTreeMap::new(),
                needs_context: BTreeMap::new(),
                container: None,
                services: Vec::new(),
                matrix_context: None,
                steps: vec![crate::runner::DtuJobStep {
                    name: "Run".to_owned(),
                    context_name: None,
                    run: Some("echo hi".to_owned()),
                    uses: None,
                    condition: None,
                    shell: None,
                    working_directory: None,
                    env: BTreeMap::new(),
                    with: BTreeMap::new(),
                }],
            })
            .unwrap();

        let (status, dump) = json_request(&server, "GET", "/_dtu/dump", Value::Null);
        assert_eq!(status, 200);
        assert_eq!(dump["runnerJobs"]["runner-a"]["id"], "job-1");
        assert_eq!(
            dump["runnerLogs"]["runner-a"].as_str(),
            Some(log_dir.to_string_lossy().as_ref())
        );
        server.close();
    }

    #[test]
    fn seeds_jobs_and_dispatches_to_runner_session() {
        let server = start_ephemeral_dtu(temp_dir("dispatch"), None).unwrap();
        let (status, _) = json_request(
            &server,
            "POST",
            "/_dtu/seed",
            json!({ "id": "job-1", "runnerName": "runner-a", "steps": [{ "name": "Run" }] }),
        );
        assert_eq!(status, 201);
        let (status, session) = json_request(
            &server,
            "POST",
            "/_apis/distributedtask/pools/1/sessions",
            json!({ "agent": { "name": "runner-a" } }),
        );
        assert_eq!(status, 200);
        let session_id = session["sessionId"].as_str().unwrap();
        let (status, message) = json_request(
            &server,
            "GET",
            &format!("/_apis/distributedtask/pools/1/messages?sessionId={session_id}"),
            Value::Null,
        );
        assert_eq!(status, 200);
        assert_eq!(message["MessageType"], "PipelineAgentJobRequest");
        let body = serde_json::from_str::<Value>(message["Body"].as_str().unwrap()).unwrap();
        assert_eq!(body["MessageType"], "PipelineAgentJobRequest");
        assert_eq!(body["Steps"][0]["displayName"], "Run");
        assert_eq!(body["Steps"][0]["inputs"]["type"], 2);
        server.close();
    }

    #[test]
    fn timeline_feed_writes_sanitized_step_logs() {
        let server = start_ephemeral_dtu(temp_dir("feed"), None).unwrap();
        let log_dir = temp_dir("feed-logs");
        let mut client = DtuHttpClient::new(&server.url);
        client
            .register_runner(&DtuRunnerRegistration {
                runner_name: "runner-a".to_owned(),
                log_dir: log_dir.clone(),
                timeline_dir: log_dir.clone(),
                virtual_cache_patterns: vec![],
            })
            .unwrap();
        let (status, _) = json_request(
            &server,
            "POST",
            "/_dtu/seed",
            json!({ "id": "job-1", "runnerName": "runner-a", "steps": [{ "name": "Run tests" }] }),
        );
        assert_eq!(status, 201);
        let (status, session) = json_request(
            &server,
            "POST",
            "/_apis/distributedtask/pools/1/sessions",
            json!({ "agent": { "name": "runner-a" } }),
        );
        assert_eq!(status, 200);
        let session_id = session["sessionId"].as_str().unwrap();
        let (status, message) = json_request(
            &server,
            "GET",
            &format!("/_apis/distributedtask/pools/1/messages?sessionId={session_id}"),
            Value::Null,
        );
        assert_eq!(status, 200);
        let body = serde_json::from_str::<Value>(message["Body"].as_str().unwrap()).unwrap();
        let plan_id = body["Plan"]["PlanId"].as_str().unwrap();
        let timeline_id = body["Timeline"]["Id"].as_str().unwrap();
        let record_id = "00000000-0000-4000-8000-000000000001";
        let (status, _) = json_request(
            &server,
            "PATCH",
            &format!("/_apis/distributedtask/timelines/{timeline_id}/records"),
            json!({ "value": [{
                "id": record_id,
                "type": "Task",
                "name": "Run tests",
                "state": "inProgress",
                "result": "succeeded"
            }] }),
        );
        assert_eq!(status, 200);
        let (status, _) = json_request(
            &server,
            "POST",
            &format!(
                "/_apis/distributedtask/hubs/Actions/plans/{plan_id}/timelines/{timeline_id}/records/{record_id}/feed"
            ),
            json!({ "value": [
                { "message": "2026-01-01T00:00:00.0000000Z ##[command]echo hello" },
                { "message": "2026-01-01T00:00:00.0000000Z hello from step" },
                { "message": "::agent-ci-output::answer=42" }
            ] }),
        );
        assert_eq!(status, 200);

        assert_eq!(
            fs::read_to_string(log_dir.join("steps/Run-tests.log")).unwrap(),
            "hello from step\n"
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(log_dir.join("outputs.json")).unwrap()
            )
            .unwrap()["answer"],
            json!("42")
        );
        server.close();
    }

    #[test]
    fn serves_registration_and_installation_endpoints() {
        let server = start_ephemeral_dtu(temp_dir("github"), None).unwrap();
        let (status, token) = json_request(
            &server,
            "POST",
            "/repos/owner/repo/actions/runners/registration-token",
            Value::Null,
        );
        assert_eq!(status, 201);
        assert!(
            token["token"]
                .as_str()
                .unwrap()
                .starts_with("ghr_mock_registration_token_")
        );
        let (status, installation) =
            request(&server, "GET", "/repos/owner/repo/installation", None);
        assert_eq!(status, 200);
        assert!(
            String::from_utf8(installation)
                .unwrap()
                .contains("access_tokens_url")
        );
        server.close();
    }

    #[test]
    fn cache_round_trip_preserves_uploaded_archive() {
        let server = start_ephemeral_dtu(temp_dir("cache"), None).unwrap();
        let (status, reserve) = json_request(
            &server,
            "POST",
            "/_apis/artifactcache/caches",
            json!({ "key": "pnpm-key", "version": "v1" }),
        );
        assert_eq!(status, 201);
        let cache_id = reserve["cacheId"].as_u64().unwrap();
        let (status, _) = request(
            &server,
            "PATCH",
            &format!("/_apis/artifactcache/caches/{cache_id}"),
            Some(b"archive"),
        );
        assert_eq!(status, 200);
        let (status, _) = json_request(
            &server,
            "POST",
            &format!("/_apis/artifactcache/caches/{cache_id}"),
            json!({ "size": 7 }),
        );
        assert_eq!(status, 200);
        let (status, hit) = json_request(
            &server,
            "GET",
            "/_apis/artifactcache/cache?keys=pnpm-key&version=v1",
            Value::Null,
        );
        assert_eq!(status, 200);
        assert_eq!(hit["result"], "hit");
        let (status, archive) = request(
            &server,
            "GET",
            &format!("/_apis/artifactcache/artifacts/{cache_id}"),
            None,
        );
        assert_eq!(status, 200);
        assert_eq!(archive, b"archive");
        server.close();
    }

    #[test]
    fn artifact_rest_round_trip_preserves_bytes() {
        let server = start_ephemeral_dtu(temp_dir("artifact"), None).unwrap();
        let (status, created) = json_request(
            &server,
            "POST",
            "/_apis/artifacts",
            json!({ "name": "logs" }),
        );
        assert_eq!(status, 201);
        let container_id = created["containerId"].as_u64().unwrap();
        let (status, _) = request(
            &server,
            "PUT",
            &format!("/_apis/artifacts/{container_id}?itemPath=out.txt"),
            Some(b"hello artifact"),
        );
        assert_eq!(status, 200);
        let (status, _) = json_request(
            &server,
            "PATCH",
            "/_apis/artifacts",
            json!({ "artifactName": "logs" }),
        );
        assert_eq!(status, 200);
        let (status, listed) = json_request(
            &server,
            "GET",
            "/_apis/artifacts?artifactName=logs",
            Value::Null,
        );
        assert_eq!(status, 200);
        assert_eq!(listed["count"], 1);
        let (status, bytes) = request(
            &server,
            "GET",
            &format!("/_apis/artifactfiles/{container_id}"),
            None,
        );
        assert_eq!(status, 200);
        assert_eq!(bytes, b"hello artifact");
        server.close();
    }

    #[test]
    fn artifact_twirp_block_blob_round_trip_preserves_bytes() {
        let server = start_ephemeral_dtu(temp_dir("twirp-artifact"), None).unwrap();
        let (status, created) = json_request(
            &server,
            "POST",
            "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact",
            json!({ "name": "zip" }),
        );
        assert_eq!(status, 200);
        let upload = created["signedUploadUrl"].as_str().unwrap();
        let container_id = upload.split('/').nth_back(1).unwrap();
        let (status, _) = request(
            &server,
            "PUT",
            &format!("/_apis/artifactblob/{container_id}/upload?comp=block&blockid=a"),
            Some(b"hello "),
        );
        assert_eq!(status, 201);
        let (status, _) = request(
            &server,
            "PUT",
            &format!("/_apis/artifactblob/{container_id}/upload?comp=block&blockid=b"),
            Some(b"world"),
        );
        assert_eq!(status, 201);
        let (status, _) = request(
            &server,
            "PUT",
            &format!("/_apis/artifactblob/{container_id}/upload?comp=blocklist"),
            Some(b"<Latest>a</Latest><Latest>b</Latest>"),
        );
        assert_eq!(status, 201);
        let (status, _) = json_request(
            &server,
            "POST",
            "/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact",
            json!({ "name": "zip" }),
        );
        assert_eq!(status, 200);
        let (status, signed) = json_request(
            &server,
            "POST",
            "/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL",
            json!({ "name": "zip" }),
        );
        assert_eq!(status, 200);
        let signed_url = signed["signedUrl"].as_str().unwrap();
        let path = signed_url
            .split_once(&format!("127.0.0.1:{}", server.port))
            .unwrap()
            .1;
        let (status, bytes) = request(&server, "GET", path, None);
        assert_eq!(status, 200);
        assert_eq!(bytes, b"hello world");
        server.close();
    }
}
