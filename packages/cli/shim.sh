#!/bin/bash
case "$1" in
  checkout|fetch|reset)
    echo "[Agent CI Shim] Intercepted '$1' to protect local files."
    exit 0
    ;;
  *)
    echo "git $@" >> /tmp/agent-ci-git-calls.log
    /usr/bin/git "$@"
    ;;
esac
