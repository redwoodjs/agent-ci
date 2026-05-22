# Homebrew formula template

`Formula/agent-ci.rb.template` is the formula source for a Homebrew tap release.
During release, replace:

- `{{VERSION}}` with the package version without the leading `v`
- `{{MACOS_ARM64_SHA256}}` with the checksum from `agent-ci-v<version>-macos-arm64.tar.gz.sha256`
- `{{MACOS_X64_SHA256}}` with the checksum from `agent-ci-v<version>-macos-x64.tar.gz.sha256`

The formula installs the native `agent-ci` binary into `bin` and includes a smoke test that runs `agent-ci --help`.
