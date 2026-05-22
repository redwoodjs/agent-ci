#!/bin/sh
set -eu

repo="redwoodjs/agent-ci"
base_url="${AGENT_CI_BASE_URL:-https://github.com/${repo}/releases/download}"
version="${AGENT_CI_VERSION:-latest}"
prefix="${AGENT_CI_PREFIX:-$HOME/.local}"
bin_dir="${AGENT_CI_BIN_DIR:-}"
os_override="${AGENT_CI_OS:-}"
arch_override="${AGENT_CI_ARCH:-}"

usage() {
  cat <<'USAGE'
Install Agent CI native binary.

Usage: curl -fsSL https://raw.githubusercontent.com/redwoodjs/agent-ci/main/install.sh | sh -s -- [options]

Options:
  --version <version>   Version tag to install, for example v0.16.1
  --prefix <dir>        Install under <dir>/bin (default: $HOME/.local)
  --bin-dir <dir>       Install directly into <dir>
  --help                Show this help

Environment:
  AGENT_CI_VERSION      Version tag to install
  AGENT_CI_PREFIX       Prefix used when --prefix is not provided
  AGENT_CI_BIN_DIR      Direct binary directory override
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      version="${2:?--version requires a value}"
      shift 2
      ;;
    --prefix)
      prefix="${2:?--prefix requires a value}"
      shift 2
      ;;
    --bin-dir)
      bin_dir="${2:?--bin-dir requires a value}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$bin_dir" ]; then
  bin_dir="$prefix/bin"
fi

detect_os() {
  if [ -n "$os_override" ]; then
    printf '%s\n' "$os_override"
    return
  fi
  case "$(uname -s)" in
    Linux) printf '%s\n' linux ;;
    Darwin) printf '%s\n' macos ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
}

detect_arch() {
  if [ -n "$arch_override" ]; then
    printf '%s\n' "$arch_override"
    return
  fi
  case "$(uname -m)" in
    x86_64|amd64) printf '%s\n' x64 ;;
    arm64|aarch64) printf '%s\n' arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

fetch_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1
  else
    echo "curl is required to resolve the latest Agent CI release" >&2
    exit 1
  fi
}

fetch() {
  src="$1"
  dst="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$src" -o "$dst"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$src" -O "$dst"
  else
    echo "curl or wget is required to install Agent CI" >&2
    exit 1
  fi
}

verify_checksum() {
  archive="$1"
  checksum_file="$2"
  checksum_dir="$(dirname "$checksum_file")"
  checksum_base="$(basename "$checksum_file")"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$checksum_dir" && shasum -a 256 -c "$checksum_base")
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$checksum_dir" && sha256sum -c "$checksum_base")
  else
    echo "shasum or sha256sum is required to verify Agent CI downloads" >&2
    exit 1
  fi
  test -s "$archive"
}

if [ "$version" = "latest" ]; then
  version="$(fetch_latest_version)"
fi
case "$version" in
  v*) ;;
  *) version="v${version}" ;;
esac

platform="$(detect_os)-$(detect_arch)"
case "$platform" in
  linux-x64|linux-arm64|macos-x64|macos-arm64) ;;
  *) echo "Unsupported Agent CI platform: $platform" >&2; exit 1 ;;
esac

archive="agent-ci-${version}-${platform}.tar.gz"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

archive_path="$tmp_dir/$archive"
checksum_path="$tmp_dir/$archive.sha256"
url="$base_url/$version/$archive"
checksum_url="$url.sha256"

echo "Downloading $url"
fetch "$url" "$archive_path"
fetch "$checksum_url" "$checksum_path"
verify_checksum "$archive_path" "$checksum_path"

tar -xzf "$archive_path" -C "$tmp_dir"
if [ ! -f "$tmp_dir/agent-ci" ]; then
  echo "Archive did not contain agent-ci binary" >&2
  exit 1
fi

mkdir -p "$bin_dir"
install -m 0755 "$tmp_dir/agent-ci" "$bin_dir/agent-ci"

echo "Installed agent-ci to $bin_dir/agent-ci"
