# Contributing to MicroPal

Focused improvements and reproducible bug reports are welcome at [Teachmetech/MicroPal](https://github.com/Teachmetech/MicroPal). Discuss changes to serial ownership, reset behavior, firmware support, or the transport interface before a large implementation. Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and the [repository instructions](AGENTS.md).

## Development setup

Use Node.js 22.22.2+ (or 24.15+), npm, and Python 3.10+. Transport tests execute generated device snippets with the available Python interpreter.

```sh
git clone https://github.com/Teachmetech/MicroPal.git
cd MicroPal
npm ci
npm run check
npm run package
```

`npm run check` runs TypeScript checking, ESLint, unit/process/transport tests, and the bundle build. `npm run package` creates a versioned `micropal-*.vsix`; install it with **Extensions: Install from VSIX…** in VS Code or a compatible Cursor release. Run **Developer: Reload Window** after an update. `npm run watch` rebuilds after source edits; reload the extension host to exercise the new bundle.

For device development, install Python 3.10+ with `venv` and `ensurepip`, open a trusted local project folder, and run **MicroPal: Set Up Tools** as described in the [README](README.md). External mpremote/esptool executable overrides remain available. The [examples](examples/README.md) provide small starting programs.

## Verification

Choose checks that exercise the changed behavior. Add regression coverage for behavior changes, then run `npm run check` and package the extension. Tests should observe behavior such as literal argument passing, port release before a new owner starts, disconnect races, no automatic replay, safe sync selection, and parse failures. Avoid requiring hardware or package downloads for unit tests.

| Check | Command | Scope |
| --- | --- | --- |
| Standard checks | `npm run check` | TypeScript, lint, unit/process/transport tests, and bundle build. |
| Editor smoke test | `npm run test:host -- code` or `npm run test:host -- cursor` | Isolated temporary profile; activation, commands, default settings, Output, Disconnect, and filesystem registration. |
| Native filesystem fixture | `npm run test:filesystem:host -- code` or `npm run test:filesystem:host -- cursor` | Isolated editor profile and disk-backed fake board; native file operations, editors, mounting, and session restoration. |
| Managed tool installation | `npm run test:tools` | Real pinned-tool download into temporary storage, version checks, reuse, and cancelled repair. Requires Python and internet access. |
| Native serial-owner recovery | `npm run test:port-release` | Disposable local PTY owners and process inspection/termination; no ESP32 access. |
| VSIX packaging | `npm run package` | Build and archive creation; inspect its contents before release. |

On Windows, supply the absolute path to `Code.exe` or `Cursor.exe` for editor tests, not a `.cmd` shim. Record exact editor and runtime versions with results. Editor fixtures do not validate physical serial access or interactive REPL behavior. The serial-owner integration is platform dependent; do not describe an unrun platform as verified.

The managed tool installation check injects conflicting pip configuration to verify isolation. Successful runs remove their temporary environment; failures retain a setup log and print its path. This check does not access a board and is excluded from `npm run check`.

Hardware-dependent changes need recorded results from the [manual acceptance checklist](docs/manual-testing.md). Include the board, firmware, USB interface, operating system, editor, and Python/tool versions. List skipped or unavailable checks explicitly. Keep the [verification record](docs/verification.md) accurate: past macOS checks do not establish Windows/Linux acceptance or every ESP32/ESP32-S3 combination.

## Architecture and behavioral requirements

The core and transport contracts are editor independent. Keep serial ownership in the device manager, command construction in the transport, process lifecycle in the runner, managed environment installation/selection in the tool service, and editor APIs in UI/extension code. See the [architecture](docs/architecture.md) for session persistence, staged filesystem writes, and cancellation details.

Do not introduce shell command interpolation, detached serial processes, telemetry, installation on activation, or automatic firmware flashing. Tool installation requires the explicit **Set Up Tools** or **Repair Tools** action, downloads from official PyPI into extension-owned storage, and leaves global Python packages and system `PATH` unchanged. Setup/repair disconnect device operations before changing managed tools. Never replay a user operation merely because a port reappears.

Device filesystem changes must preserve connection-session validation and byte-safe operations. A stale editor must not save to a new board after reconnect, disconnect, or flashing. Native filesystem operations require an idle MicroPal connection, and raw-REPL access can interrupt board code. Keep these consequences clear in user documentation.

Managed tools pin `mpremote==1.29.0` and `esptool==5.0.2`. When updating these pins, verify package availability, supported Python versions, both CLI version commands, and run/upload/REPL/flash behavior. Build each `env-UUID` generation at its final location: virtual-environment scripts contain absolute interpreter paths, so moving a completed environment can break them. Select a generation through the atomic `tools.json` pointer only after verification; preserve the previous active generation on failure/cancellation and retain earlier successful generations. Keep installation tests separate from unit tests that must not download packages or access hardware.

## Issues and pull requests

For bugs, include OS/editor versions, board and USB interface, MicroPython and mpremote versions, reproduction steps, expected/actual results, and relevant output. Remove USB serial numbers, usernames, secrets, and proprietary source from logs before sharing. Use [SECURITY.md](SECURITY.md) for vulnerabilities.

Create a focused branch and open a pull request targeting `production`. Explain the user-visible problem and resulting behavior, and include automated checks and any hardware/editor results. Update documentation when command behavior, settings, limits, or installation steps change. Contributions are made under the repository's MIT license.

Use a Conventional Commit pull request title; the squash commit title determines the automatic release:

```text
fix: preserve a dirty device editor after reconnect
feat: add a new device transfer action
docs: clarify firmware bootloader selection
```

`feat` requests a minor release; `fix` and other supported non-breaking types request a patch release. Mark an incompatible change with `!` and explain it with a `BREAKING CHANGE:` footer. See the [release guide](docs/releasing.md) for the configured types and exact version rules. Do not manually bump the package version for a normal pull request; the release job owns versioning.

## Changelog requirement

Every change intended to go live must add a complete entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) in the same pull request. Cover features, fixes, behavior, configuration, dependencies, documentation, release automation, and security changes. Describe the effect on users or maintainers and any migration, limitation, or compatibility impact. Use the Added, Changed, Fixed, Removed, or Security sections as appropriate. Do not use generic entries such as “fix bugs,” and do not replace earlier entries. Follow [AGENTS.md](AGENTS.md) for the repository-wide rule; CI checks changelog coverage, while reviewers must check its completeness.

A useful entry describes what a user can observe:

```markdown
- When reconnecting after a board switch, preserve unsaved edits in an old device editor and reject saves until the file is reopened from the current ESP32 Files root.
```

Maintainer-authored Unreleased entries supply the detail that an automatically generated commit summary cannot infer. The release process promotes them into the versioned changelog and includes release notes derived from supported Conventional Commit types.

## Release overview

Reviewed merges to `production` trigger the release workflow after its checks pass. semantic-release derives the next version from the commits, promotes detailed Unreleased notes into a dated version section, commits updated versions/lockfile/changelog, and creates a GitHub release with one VSIX. Independent store jobs publish that same artifact to Visual Studio Marketplace and Open VSX. Verify the GitHub release and each store result separately; one successful destination does not establish that the others succeeded. Publisher registration, repository configuration, and credentials must be valid before publication can succeed.

Maintainers should read [docs/releasing.md](docs/releasing.md) for publisher registration, GitHub/environment permissions, secrets, branch protection, the first public release, release verification, and recovery. Before publishing, inspect the VSIX, review dependencies and managed-tool pins, and record the platform/hardware acceptance results. Python, managed virtual environments, firmware images, serial logs, credentials, and development scratch files must not be bundled.

Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when changing bundled dependencies or managed tools.

The README links to Visual Studio Marketplace and Open VSX only after the real listings have been verified. Avoid fabricated badges, download counts, release status, or publisher/install identifiers.
