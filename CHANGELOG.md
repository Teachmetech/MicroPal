# Changelog

All changes intended for public delivery are recorded here. Release automation promotes the detailed Unreleased entries into a dated version section and publishes the same notes with the GitHub release.

## [Unreleased]

### Added

- Show a live ESP32 console automatically after Connect in the MicroPal Output panel. A passive reader uses the managed Python environment and never sends REPL commands, requests a reset, or replays user code. Connect uses reader readiness when available; custom mpremote installations without managed tools retain the existing connection probe and explain how to enable live output. The serial library may discard buffered bytes on open, and USB drivers can toggle control lines; output from before attachment or between owners is not recovered.
- Added default-on, machine-scoped `microPal.autoShowOutput`. Turning it off releases the idle serial port for other applications; turning it on can start the reader for the current connection. A failed reader is reported once and requires an explicit Connect or setting change to retry.
- Added official MicroPython firmware selection and download directly inside **Flash Firmware**: choose ESP32/ESP32-S3, a supported flash/PSRAM variant, and a stable release, with the latest stable version first. Official combined images use their known chip-specific flash address; local BIN selection and address overrides remain available.
- Added cancellable catalog and download progress, bounded HTTPS requests to official MicroPython paths, atomic private download storage, combined-image header/chip checks, and source/local SHA-256 records. These checks identify malformed or wrong-family downloads; the local hash is not an upstream signature or published checksum.
- Added console lifecycle, cancellation, serial handoff and firmware parser/download/wizard regression coverage, plus an implementation plan and editor-host checks for the new setting.

### Changed

- Idle live output now owns the serial port. File operations, uploads, Run, REPL, Stop, reset, tool setup, flashing, and Disconnect wait for the console process to close before taking ownership; the console resumes when foreground work is finished and the same connection remains valid. Run continues streaming its own output and the interactive REPL keeps its real terminal.
- Firmware dialogs retain explicit erase-mode and final destructive confirmation before acquiring the serial port. Catalog lookup and downloads can be cancelled without flashing, and workspace trust is checked again before hardware writes.
- Updated the README, architecture, status-bar guidance, and manual acceptance checklist for live output, serial handoffs, managed-tool requirements, official firmware downloads, and remaining hardware verification limits. Native Explorer filesystem requests still enter raw REPL and may interrupt code started independently on the board; automatic output does not restart that code.
- Anchored the local firmware-artifact ignore rule to the repository root so the firmware service source is tracked. No dependencies, publisher identity, or public version were changed.

## 0.3.0 (2026-10-10)

## [0.3.0](https://github.com/Teachmetech/MicroPal/compare/v0.2.1...v0.3.0) (2026-10-10)

### Features

* **release:** prepare public MicroPal distribution ([6a3855a](https://github.com/Teachmetech/MicroPal/commit/6a3855a06a7782038820732e0740b245f9f7c1c7))

### Fixes

* **ci:** repair clean installs and document publisher setup ([035b259](https://github.com/Teachmetech/MicroPal/commit/035b25997283e14e1bcb46948744fee344cbf3ab))

### Tests

* **ci:** make binary and path fixtures portable ([dce6c89](https://github.com/Teachmetech/MicroPal/commit/dce6c89695aaa1f14f48585779995958e4533add))


### Maintainer notes

### Added

- Created the public `Teachmetech/MicroPal` GitHub repository with MIT licensing, private vulnerability reporting, contribution guidance, and issue/pull-request templates.
- Added a comprehensive README with the MicroPal logo, quick start, feature/platform matrices, firmware flashing, direct ESP32 file editing and transfers, connection recovery, commands, settings, migration, troubleshooting, and verification limits.
- Added automated production releases with semantic version selection, dated changelog entries, GitHub tags/Releases, a single versioned VSIX and checksums, and independent VS Code Marketplace/Open VSX publication jobs. Open VSX supplies Cursor extensions; store accounts and authentication must be configured before store publication can succeed.
- Added Linux/macOS/Windows CI, pull-request title and changelog validation, release-behavior regression tests, and documented recovery for partial store-publication failures.
- Added repository-wide `AGENTS.md` instructions requiring complete changelog coverage for every live delivery, with Claude/Gemini entry points and explicit release verification rules.
- Added `.gitignore` rules for generated output, dependencies, local environments, credentials, hardware artifacts, diagnostic logs, and editor state.

### Changed

- Configured the public extension identity as `teachmetech.micropal` and added real repository, homepage, and issue-tracker metadata. This is a separate identity from local `micropal-local.micropal`; disconnect/disable the local build, preserve unsaved device edits, install the public build, and run managed setup again. Existing `microPal.*` setting names remain the same.
- Made package filenames follow the actual manifest version, so automated releases no longer require editing a hard-coded VSIX path.
- Updated packaging to VSCE 4 and pinned semantic-release, its Git/changelog integrations, and the Open VSX CLI; retained the lockfile for reproducible builds and documented remaining development-tool dependency advisories. CI rejects production dependency vulnerabilities.
- Documented production merge conventions, publishing-account registration, modern OIDC authentication, transitional PAT use, first-publication requirements, and repository/environment configuration.
- Added a publisher onboarding guide with the exact Marketplace/Open VSX account steps and repository settings required to activate automatic publication; aligned development prerequisites with the release tools' Node.js 22.22.2+/24.15+ requirements and updated the architecture/verification documentation for hosted CI.

### Fixed

- Included the full license notices for the JavaScript dependencies embedded in the extension bundle.
- Restricted VSIX contents to an explicit allowlist, retaining user-facing documentation and excluding development plans, local verification records, source/tests, release tooling, credentials, and generated artifacts.
- Updated editor smoke checks for the public identity and removed documentation that claimed an unavailable F5 launch configuration.
- Corrected managed-tool test fixtures to use their declared platform during reload and compare storage paths without operating-system-specific separators or unescaped regular expressions.
- Regenerated the dependency lockfile with CI's npm 10 resolver so Vite's optional esbuild peer and its platform packages are recorded correctly; clean installs no longer reject the lockfile on Node.js 22.
- Made the large binary-transfer regression compare every byte with a native buffer comparison, preserving exact-content coverage without slow per-property assertions that timed out on hosted macOS runners.
- Aligned host filesystem test fixtures with POSIX device rename-overwrite behavior on Windows, and normalized native paths in transfer-dialog expectations.

### Security

- Added production-only publishing permissions and environment restrictions, immutable artifact verification, secret-free pull-request checks, and private GitHub advisory reporting links.

## 0.2.1 — 2026-10-09 (local development)

- Connect on macOS/Linux detects processes holding the selected serial port, including the matching macOS call-in/call-out alias.
- Automatically releases surviving MicroPal-managed REPL processes before retrying Connect. The machine-scoped `microPal.autoReleasePort` setting can disable this automatic step.
- Other owners are identified by process name and PID with **Release Port and Connect**. Force termination requires a separate confirmation, and every signal revalidates the approved process identity and port ownership.
- Cancels recovery when the connection changes; Explorer reads, background discovery, and firmware flashing never invoke this recovery flow.

## 0.2.0 — 2026-10-09 (local development)

- Added a writable **ESP32 Files** root below local workspace folders in the native Explorer, with direct editor saves, new files/folders, rename, permanent delete, and file/folder transfers in both directions.
- Added **Open ESP32 Files in Explorer** and **Close ESP32 Files** commands. Connect opens the native device root when a local project folder is available.
- Added explicit local file/folder upload pickers and file/folder downloads from the native Explorer. Transfers retain their source, refuse existing destinations, and preserve the selected connection across dialogs.
- Native Explorer drag moves items; Option-drag on macOS, Ctrl-drag on Windows/Linux, or copy/paste copies them while keeping the source.
- Replaced read-only snapshot editors with binary-safe device filesystem operations, typed filesystem errors, and resource/parent change notifications. Watches do not poll; **Refresh Device Files** sees external changes.
- Bound device documents to connection sessions and reject stale saves after explicit reconnect, disconnect, or flashing. Mounted sessions restore after editor-host restart only for a matching USB serial identity, without a REPL probe.
- Persisted session revocation so reloading cannot revive an explicitly disconnected mount or its old documents.
- Added staged filesystem writes that preserve existing destinations on transfer failure. Cancellation can leave a hidden staging file; filesystems without rename-based replacement reject overwrites safely.
- Filesystem operations retain the serial-ownership policy: stop a MicroPal Run session or close its REPL first. Raw-REPL filesystem access can interrupt code started independently by the board.

## 0.1.1 — 2026-10-09 (local development)

- Added a MicroPal logo to the extension listing and details page.
- Documented local VSIX updates in Cursor and migration from the earlier ESP32 Workbench extension identity.

## 0.1.0 — 2026-10-08 (local development)

- Renamed the project, extension UI, commands, settings, and local package to MicroPal.
- Added confirmed esptool 5.x firmware flashing for ESP32/ESP32-S3, with chip/address selection, optional full erase, streamed output, cancellation, and shared serial ownership.
- Added explicit **Set Up Tools** and **Repair Tools** commands for a private Python environment with `mpremote==1.29.0` and `esptool==5.0.2`, downloaded from official PyPI after a user action.
- Empty tool-path settings now use managed executables; explicit executable overrides take precedence. Added Python 3.10+ discovery and a machine-scoped Python executable setting; Python is not bundled.
- Managed setup/repair disconnect active device work, stream progress, support cancellation, and switch an atomic active pointer only after verification. Failed or cancelled attempts preserve the previously active environment; older successful generations are retained.
- Initial local ESP32/ESP32-S3 MicroPython extension scaffold for VS Code and compatible Cursor releases.
- Device discovery and selection, connection state, and presence-based reconnection without automatic replay.
- Run, upload, project sync, stop, soft reset, real-terminal REPL, and device file snapshots/downloads.
- Serialized extension-owned serial access with confirmed subprocess/terminal shutdown before handoff.
- Safe subprocess argument passing, output capture limits, deadlines, and cancellation.
- Sync exclusions, symlink skipping, and preservation of remote files outside the uploaded set.
- Automated tests, local VSIX packaging, community documents, and a manual acceptance checklist.

Hardware/editor-host acceptance is pending. V1 supports mpremote's fixed 115200 baud only. Debugging and remote/WebREPL transports are deferred.
