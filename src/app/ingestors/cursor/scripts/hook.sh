#!/bin/bash
set -e

# Read the input from stdin
INPUT=$(cat)

LOG_DIR="${CURSOR_INGEST_LOG_DIR:-/tmp/machinen/cursor}"
LOG_FILE="${CURSOR_INGEST_LOG_FILE:-$LOG_DIR/ingestion.log}"

mkdir -p "$LOG_DIR"

if [ -f "$LOG_FILE" ]; then
  LOG_LINE_COUNT=$(wc -l < "$LOG_FILE" | tr -d ' ')
  LOG_MAX_LINES="${CURSOR_INGEST_LOG_MAX_LINES:-5000}"
  if [ "$LOG_LINE_COUNT" -gt "$LOG_MAX_LINES" ]; then
    tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

LOG_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
LOG_ID="${LOG_TS}-$$"

{
  echo ""
  echo "[$LOG_TS] hook_start id=$LOG_ID user=$USER host=$(hostname) pid=$$"
  echo "[$LOG_TS] env CURSOR_INGEST_URL=${CURSOR_INGEST_URL:-} MACHINEN_API_URL=${MACHINEN_API_URL:-}"
  echo "[$LOG_TS] env INGEST_API_KEY_set=$([ -n "${INGEST_API_KEY:-}" ] && echo 1 || echo 0) MACHINEN_API_KEY_set=$([ -n "${MACHINEN_API_KEY:-}" ] && echo 1 || echo 0)"
} >> "$LOG_FILE" 2>&1

# Define the endpoint URL (defaults to production, override with CURSOR_INGEST_URL or MACHINEN_API_URL env var)
ENDPOINT_URL="${CURSOR_INGEST_URL:-${MACHINEN_API_URL:-https://machinen.redwoodjs.workers.dev/ingestors/cursor}}"

# Get API key from environment variable
API_KEY="${INGEST_API_KEY:-${MACHINEN_API_KEY:-}}"

if [ -z "$API_KEY" ]; then
  {
    echo "[$LOG_TS] hook_error id=$LOG_ID missing_api_key"
    echo "[$LOG_TS] hook_end id=$LOG_ID"
  } >> "$LOG_FILE" 2>&1
  echo "Error: INGEST_API_KEY (or MACHINEN_API_KEY) environment variable is not set" >&2
  exit 1
fi

INPUT_BYTES=$(printf '%s' "$INPUT" | wc -c | tr -d ' ')
INPUT_SHA=$(printf '%s' "$INPUT" | shasum -a 256 | awk '{print $1}')

{
  echo "[$LOG_TS] request id=$LOG_ID url=$ENDPOINT_URL input_bytes=$INPUT_BYTES input_sha256=$INPUT_SHA"
} >> "$LOG_FILE" 2>&1

(
  set +e
  CURL_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  RESP_BODY_PATH="$(mktemp "$LOG_DIR/response.body.XXXXXX")"
  CURL_ERR_PATH="$(mktemp "$LOG_DIR/curl.stderr.XXXXXX")"

  HTTP_CODE="$(
    curl --silent --show-error \
      --max-time "${CURSOR_INGEST_CURL_TIMEOUT_SECONDS:-10}" \
      --write-out '%{http_code}' \
      --output "$RESP_BODY_PATH" \
      --header "Content-Type: application/json" \
      --header "Authorization: Bearer $API_KEY" \
      --data "$INPUT" \
      "$ENDPOINT_URL" 2> "$CURL_ERR_PATH"
  )"
  CURL_EXIT="$?"
  set -e

  RESP_BYTES="$(wc -c < "$RESP_BODY_PATH" | tr -d ' ')"
  ERR_BYTES="$(wc -c < "$CURL_ERR_PATH" | tr -d ' ')"

  echo "[$CURL_TS] response id=$LOG_ID http_code=$HTTP_CODE curl_exit=$CURL_EXIT resp_bytes=$RESP_BYTES curl_stderr_bytes=$ERR_BYTES" >> "$LOG_FILE" 2>&1

  if [ "$ERR_BYTES" -gt 0 ]; then
    echo "[$CURL_TS] curl_stderr_begin id=$LOG_ID" >> "$LOG_FILE" 2>&1
    cat "$CURL_ERR_PATH" >> "$LOG_FILE" 2>&1
    echo "[$CURL_TS] curl_stderr_end id=$LOG_ID" >> "$LOG_FILE" 2>&1
  fi

  RESP_LOG_BYTES_LIMIT="${CURSOR_INGEST_LOG_RESPONSE_BYTES_LIMIT:-2000}"
  if [ "$RESP_BYTES" -gt 0 ]; then
    echo "[$CURL_TS] response_body_begin id=$LOG_ID (first_${RESP_LOG_BYTES_LIMIT}_bytes)" >> "$LOG_FILE" 2>&1
    head -c "$RESP_LOG_BYTES_LIMIT" "$RESP_BODY_PATH" >> "$LOG_FILE" 2>&1
    echo "" >> "$LOG_FILE" 2>&1
    echo "[$CURL_TS] response_body_end id=$LOG_ID" >> "$LOG_FILE" 2>&1
  fi

  rm -f "$RESP_BODY_PATH" "$CURL_ERR_PATH"
  echo "[$CURL_TS] hook_end id=$LOG_ID" >> "$LOG_FILE" 2>&1
) &
