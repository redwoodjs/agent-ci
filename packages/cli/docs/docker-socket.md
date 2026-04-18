# Docker socket setup

agent-ci launches GitHub Actions runners in Docker containers and bind-mounts the host's Docker socket into each runner so `docker build` / `docker run` steps work. For that bind-mount to survive Docker's mount layer (especially on macOS, where Docker runs inside a VM), agent-ci needs **a working Docker socket at `/var/run/docker.sock`**.

If you see an error like `agent-ci couldn't use a Docker socket at /var/run/docker.sock`, use the recipe below that matches your Docker provider.

## Why `/var/run/docker.sock` specifically?

Docker's mount subsystem (both on native Linux and through Docker's macOS VM) treats `/var/run/docker.sock` as a canonical path. Provider-specific paths like `~/.orbstack/run/docker.sock` or `~/.colima/<profile>/docker.sock`:

- may be forwarded sockets that don't exist _inside_ the provider's VM (so Docker can't bind-mount them),
- disappear the moment you stop that provider,
- may get shadowed when you switch providers (e.g. OrbStack creates `/var/run/docker.sock` as a symlink that dangles if you later swap to Colima).

Relying on `/var/run/docker.sock` as the single source of truth avoids all of that.

## Recipes

### Docker Desktop (macOS / Windows / Linux)

Docker Desktop creates `/var/run/docker.sock` automatically on startup. If it's missing, just start Docker Desktop (or restart it if it was running during an upgrade).

### OrbStack (macOS)

OrbStack creates `/var/run/docker.sock` as a symlink to `~/.orbstack/run/docker.sock` on first startup. Start OrbStack and the link is created.

If you previously used OrbStack and have since switched providers, the symlink may be left dangling. Remove it and set up the new provider's link (see below).

### Colima (macOS)

Colima does **not** create `/var/run/docker.sock` by default. Create the symlink yourself:

```sh
colima start                                                 # if not already running
sudo ln -sf "$HOME/.colima/docker.sock" /var/run/docker.sock
```

Why the top-level `~/.colima/docker.sock` and not `~/.colima/<profile>/docker.sock`? The profile-internal path is the socket Colima advertises via `docker context inspect`, but Docker's mount layer can't bind-mount it through Colima's VM ([operation not supported]). The top-level alias `~/.colima/docker.sock` is the stable, mountable entry point.

### Native Linux (dockerd)

`/var/run/docker.sock` should already exist — that's where dockerd creates it. If it's missing, check that the Docker daemon is running (`systemctl status docker`). If it exists but you can't R/W it, add yourself to the `docker` group (`sudo usermod -aG docker $USER` and re-login) — agent-ci handles the "exists but not readable by our UID" case by reading the socket path from `docker context inspect` and still using `/var/run/docker.sock` as the bind-mount source.

### Rootless Docker / custom locations

If your daemon's socket lives somewhere else (e.g. `/run/user/1000/docker.sock` for rootless), set `DOCKER_HOST` explicitly:

```sh
export DOCKER_HOST=unix:///run/user/1000/docker.sock
```

agent-ci honours `DOCKER_HOST` ahead of `/var/run/docker.sock` and uses your explicit path for both the API client and the container bind-mount.

## Diagnosing "but it's right there"

If `/var/run/docker.sock` seems to exist but agent-ci still errors:

```sh
ls -la /var/run/docker.sock        # is it a regular socket, or a dangling symlink?
readlink /var/run/docker.sock      # where does the symlink point?
ls -la "$(readlink /var/run/docker.sock)"   # does the target exist?
```

A common failure mode after switching Docker providers: the old provider left a symlink pointing at its now-missing socket. Delete the symlink and start the new provider (or create a fresh symlink as shown above).
