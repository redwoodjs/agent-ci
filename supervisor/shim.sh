#!/bin/bash
case "$1" in
  checkout|fetch|reset)
    echo "[OA Shim] Intercepted '$1' to protect local files."
    exit 0
    ;;
  *)
    echo "git $@" >> /tmp/oa-git-calls.log
    /usr/bin/git "$@"
    ;;
esac
