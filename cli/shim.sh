#!/bin/bash
case "$1" in
  checkout|fetch|reset)
    echo "[Machinen Shim] Intercepted '$1' to protect local files."
    exit 0
    ;;
  *)
    echo "git $@" >> /tmp/machinen-git-calls.log
    /usr/bin/git "$@"
    ;;
esac
