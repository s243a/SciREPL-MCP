# Source release checklist

The first public repository and app-connected broker release is `v0.1.0`.
The Playwright driver has its own package version, `1.0.0`; including it in the
repository's `v0.1.0` source snapshot does not re-version the driver. If either
package is published separately in the future, establish package-scoped tag
and publishing conventions before that release.

## Prepare the release commit

- Decide which open feature pull requests belong in the release. Rebase any
  selected pull request onto the release-preparation commit and rerun every
  gate below; do not rely only on checks from its older base.
- Confirm the root and broker `package.json` versions are `0.1.0` and the
  Playwright driver's version remains `1.0.0`.
- Change `## 0.1.0 - Unreleased` in `CHANGELOG.md` to the release date only in
  the final release commit. The preparation branch should keep `Unreleased`.
- Compare every direct dependency and locked version in
  `THIRD_PARTY_NOTICES.md` with both package lockfiles. Review the complete
  resolved graphs with the audit commands below.
- Review `git diff --check`, the release diff, and the exact commit that will be
  tagged. Keep generated setup output such as credentials and generated broker
  launchers, along with `node_modules` and local configuration, out of the
  repository and release artifacts. The tracked `setup-broker.sh` and
  `setup-broker.ps1` entry points belong in every source archive.

## Run local gates

Use a supported Node.js release (Node 22 is recommended):

```bash
npm run install:all
npm run check
npm test
npm run audit
```

The broker setup suite includes a dependency-free clean-source regression. It
must prove that `--help` works before installation, that normal setup reaches
`npm ci` before loading installed dependencies, and that unsupported Node
versions receive the Node 20+ error. Also manually exercise the public setup
entry point on any platform whose instructions changed:

- `./setup-broker.sh --help` and a core setup on Linux, WSL, macOS, or Termux;
- `./setup-broker.ps1 --help` and a core setup on native Windows;
- terminal setup and a real PTY on each platform for which terminal support is
  being claimed.

Native Windows currently supports the core bridge only; agent and terminal
modes should be tested and documented under WSL. Termux core setup should be
tested separately from the optional on-device `node-pty` build.

## Require green CI

Wait for all GitHub Actions jobs on the final release commit:

- broker core on Linux, macOS, and Windows with Node 20, 22, and 24;
- broker terminal tests on Linux and macOS with the optional `node-pty` install;
- Playwright driver protocol tests on Linux, macOS, and Windows with Node 20,
  22, and 24;
- the Chromium browser smoke test;
- both production dependency audits at `moderate` severity or higher.

Do not tag a commit with a skipped, stale, or failing required job.

## Tag and publish

After the reviewed release commit and CI are green:

1. Create a signed annotated `v0.1.0` Git tag at that exact commit and verify it
   with `git tag -v v0.1.0` before pushing it.
2. Build versioned `.tar.gz` and `.zip` source archives from the tag without
   generated setup output, installed dependencies, or local configuration; keep
   the tracked Bash and PowerShell setup entry points in the archives.
   Create `SHA256SUMS` for those exact archive bytes. These are the stable,
   verifiable source assets; GitHub's generated source links are convenience
   downloads whose compressed bytes may change over time, as described in
   [GitHub's archive-stability documentation](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives#stability-of-source-code-archives).
3. Create a GitHub release from the tag and attach both versioned source
   archives and `SHA256SUMS`. Lead the release notes with the repository/broker
   version (`0.1.0`), the independently versioned Playwright driver (`1.0.0`),
   the source-only/no-npm distribution status, the exact commit, and the green
   CI run; then include the `0.1.0` changelog entry. No binary or npm assets are
   needed for this source-only release.
4. Download each attached archive, verify it against `SHA256SUMS`, and exercise
   the documented setup commands from a fresh extraction. Then verify the
   release page and `/releases/latest` redirect before linking the app's help UI
   to the release.

Creating a preparation branch or pull request does not authorize tagging or
publishing; those are deliberate maintainer release actions after all gates.
