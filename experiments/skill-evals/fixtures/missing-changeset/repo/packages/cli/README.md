# @example/cli

The CLI for the example package.

## Install

```bash
npm install -g @example/cli
```

## Usage

```bash
example-cli run
```

## Docker configuration

To use the CLI with a remote Docker daemon, set the `EXAMPLE_DOCKER_HOST`
environment variable to the daemon's socket URL:

```bash
EXAMPLE_DOCKER_HOST=ssh://user@host example-cli run
```

Both `unix://` and `ssh://` schemes are supported.
