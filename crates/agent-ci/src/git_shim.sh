#!/bin/bash

# Log every call for debugging
AGENT_CI_GIT_LOG=/tmp/agent-ci-git-calls.log
echo "git $*" >> "$AGENT_CI_GIT_LOG" 2>/dev/null || true

if [[ "$*" == *"config --local --get remote.origin.url"* || "$*" == *"config --get remote.origin.url"* ]]; then
  echo "https://github.com/${GITHUB_REPOSITORY}"
  exit 0
fi

if [[ "$*" == *"config --global --add safe.directory"* || "$*" == *"config --global --unset-all safe.directory"* ]]; then
  echo "[Agent CI Shim] Intercepted safe.directory config."
  exit 0
fi

if [[ "$*" == *"config --local --get-regexp submodule"* ]]; then
  exit 1
fi

if [[ "$*" == *"config --local --name-only --get-regexp"* && "$*" == *"extraheader"* ]]; then
  echo "http.https://github.com/.extraheader"
  exit 0
fi

if [[ "$*" == *"config --local --unset-all"* && "$*" == *"extraheader"* ]]; then
  echo "[Agent CI Shim] Intercepted extraheader cleanup."
  exit 0
fi

if [[ "$*" == *"ls-remote"* ]]; then
  echo "__AGENT_CI_FAKE_SHA__\tHEAD"
  echo "__AGENT_CI_FAKE_SHA__\trefs/heads/main"
  exit 0
fi

if [[ "$*" == *"fetch"* ]]; then
  echo "[Agent CI Shim] Intercepted 'fetch' - workspace is pre-populated."
  if ! /usr/bin/git.real rev-parse HEAD >/dev/null 2>&1; then
    /usr/bin/git.real config user.name "agent-ci" 2>/dev/null
    /usr/bin/git.real config user.email "agent-ci@example.com" 2>/dev/null
    /usr/bin/git.real add -A 2>/dev/null
    /usr/bin/git.real commit --allow-empty -m "workspace" 2>/dev/null
  fi
  /usr/bin/git.real update-ref refs/remotes/origin/main HEAD 2>/dev/null || true
  exit 0
fi

if [[ "$*" == *"checkout"* && "$*" == *"refs/remotes/origin/"* ]]; then
  echo "[Agent CI Shim] Redirecting remote checkout - recreating main from HEAD."
  /usr/bin/git.real checkout -B main HEAD
  exit $?
fi

if [[ "$*" == *"checkout"* && "$*" == *"__AGENT_CI_FAKE_SHA__"* ]]; then
  echo "[Agent CI Shim] Redirecting fake-SHA checkout to the pre-populated HEAD."
  /usr/bin/git.real checkout -B main HEAD
  exit $?
fi

if [[ "$*" == *"reset"* && "$*" == *"__AGENT_CI_FAKE_SHA__"* ]]; then
  echo "[Agent CI Shim] Redirecting fake-SHA reset to the pre-populated HEAD."
  /usr/bin/git.real reset --hard HEAD
  exit $?
fi

if [[ " $* " == *" clean "* || " $* " == *" rm "* ]]; then
  echo "[Agent CI Shim] Intercepted workspace cleanup to protect local files."
  exit 0
fi

if [[ "$1" == "rev-parse" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "HEAD" || "$arg" == "refs/heads/main" || "$arg" == "refs/remotes/origin/main" ]]; then
      echo "__AGENT_CI_FAKE_SHA__"
      exit 0
    fi
  done
fi

echo "git $@ (pass-through)" >> "$AGENT_CI_GIT_LOG" 2>/dev/null || true
/usr/bin/git.real "$@"
EXIT_CODE=$?
echo "git $@ exited with $EXIT_CODE" >> "$AGENT_CI_GIT_LOG" 2>/dev/null || true
exit $EXIT_CODE
