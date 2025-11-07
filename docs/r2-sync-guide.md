# R2 Bucket Sync Guide (rclone)

This guide explains how to download/sync R2 bucket contents to your local machine using rclone.

## Prerequisites

Install rclone:

```bash
# macOS
brew install rclone

# Linux/Other
# Follow instructions at https://rclone.org/install/
```

## Getting R2 Credentials

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **R2** > **Manage R2 API Tokens**
3. Create a new API token with read permissions
4. Note down:
   - **Account ID** (found in R2 dashboard URL or account settings)
   - **Access Key ID**
   - **Secret Access Key**

## Setup

### Quick Setup (Using Script)

Run the setup script:

```bash
./scripts/setup-r2-rclone.sh
```

This will prompt you for your credentials and configure rclone automatically.

### Manual Setup

1. Configure rclone:
   ```bash
   rclone config
   ```

2. Choose "New remote" and configure:
   - Name: `r2`
   - Type: `s3`
   - Provider: `Cloudflare`
   - Access Key ID: your access key
   - Secret Access Key: your secret key
   - Region: `auto`
   - Endpoint: `https://<account-id>.r2.cloudflarestorage.com`

## Syncing Buckets

### Using the Helper Script

Sync entire bucket:
```bash
./scripts/sync-r2-bucket.sh machinen ./r2-backup/machinen
```

Sync specific prefix/directory:
```bash
./scripts/sync-r2-bucket.sh machinen ./r2-backup/github github/
```

### Using rclone Directly

Sync entire bucket:
```bash
rclone sync r2:machinen ./r2-backup/machinen --progress
```

Sync specific prefix:
```bash
rclone sync r2:machinen/github ./r2-backup/github --progress
```

List files without downloading:
```bash
rclone ls r2:machinen/github
```

List directories:
```bash
rclone lsd r2:machinen
```

## Common Prefixes

Based on the codebase, common prefixes include:

- `github/` - GitHub ingestor data
- `discord/` - Discord ingestor data
- `cursor-conversations/` - Cursor ingestor data

## Useful rclone Commands

**Dry run (preview what will be synced):**
```bash
rclone sync r2:machinen ./backup --dry-run
```

**Copy instead of sync (preserves files in destination):**
```bash
rclone copy r2:machinen ./backup --progress
```

**Check differences:**
```bash
rclone check r2:machinen ./backup
```

**Show size of remote:**
```bash
rclone size r2:machinen
```

**Show size of specific prefix:**
```bash
rclone size r2:machinen/github
```

**Mount as filesystem (read-only):**
```bash
rclone mount r2:machinen ./mnt --daemon
```

## Tips

- Use `--progress` flag to see transfer progress
- Use `--dry-run` to preview changes before syncing
- The sync operation is incremental - only changed/new files will be downloaded on subsequent runs
- For large buckets, consider syncing specific prefixes to avoid downloading everything at once
- rclone supports many advanced options like bandwidth limiting, retries, and filters - see `rclone sync --help` for details

