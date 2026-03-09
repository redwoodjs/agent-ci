# Releasing

Machinen uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing. The CLI (`machinen`) and DTU (`dtu-github-actions`) are always released together at the same version.

## Making a Release

### 1. Add a Changeset

When you make a change worth releasing, run:

```sh
pnpm changeset
```

This opens an interactive prompt where you:

- Select the packages affected (both are bumped together regardless)
- Choose the bump type: `patch`, `minor`, or `major`
- Write a summary of the change

This creates a markdown file in `.changeset/` — commit it with your PR.

### 2. Merge to `main`

When your PR is merged, the [release workflow](.github/workflows/release.yml) runs automatically and creates a **"Version Packages"** PR that:

- Bumps versions in both `package.json` files
- Updates `CHANGELOG.md` in each package
- Consumes the changeset files

Multiple changesets accumulate into a single Version PR.

### 3. Publish

Merge the "Version Packages" PR. The release workflow runs again, this time:

- Builds both packages
- Publishes to npm
- Creates git tags

## Setup

The GitHub repo needs an `NPM_TOKEN` secret with publish access.

## Local Commands

| Command          | Description                                    |
| ---------------- | ---------------------------------------------- |
| `pnpm changeset` | Add a new changeset                            |
| `pnpm version`   | Apply pending changesets locally (for testing) |
| `pnpm release`   | Build all packages and publish to npm          |
| `pnpm -r build`  | Build all packages without publishing          |
