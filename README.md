# Machinen, by RedwoodSDK

![Machinen Logo](./logo.svg)

## What is Machinen?

Machinen is a Discord message ingestor built with RedwoodSDK. It fetches messages from Discord channels and stores them as artifacts in Cloudflare R2 for processing and analysis.

## Architecture

Machinen follows a Sources → Artifacts → Subjects pattern:

- **Sources**: Discord channel configurations
- **Artifacts**: Immutable captures of messages from channels
- **Subjects**: Derived concepts extracted from messages

## Quickstart

Install dependencies and start the development server:

```bash
pnpm install
pnpm dev
```

## Configuration

Set your Discord bot token in `.dev.vars`:

```
DISCORD_BOT_TOKEN=your_token_here
```

For production deployment:

```bash
wrangler secret put DISCORD_BOT_TOKEN
```

## Usage

Ingestion runs automatically every 6 hours via Cloudflare Cron Triggers, or you can trigger it manually:

```
GET /ingest/discord
```

## Documentation

- [Discord Ingestor Setup](./docs/discord-ingestor-setup.md)
- [Discord Ingestor](./docs/discord-ingestor.md)
- [Architecture: Sources-Artifacts-Subjects](./docs/architecture/sources-artifacts-subjects.md)

## Licensing

This is released under the FSL license.
