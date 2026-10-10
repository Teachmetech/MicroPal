# Verification record

## Public release preparation — 2026-10-09

- Typechecking, linting, build, and 426 tests across 18 suites passed locally. The isolated release integration creates a real VSIX and verifies the `v0.2.1` to `v0.3.0` version transition, persisted human/generated changelog notes, version commit, tag, packaged identity, and artifact checksum.
- VS Code 1.140.0 and Cursor's VS Code API 1.128.0 passed editor smoke checks for the public `teachmetech.micropal` identity, all 19 commands, defaults, Output, Disconnect, and filesystem provider registration.
- The packaged VSIX contains the logo, complete bundled dependency license notices, and the intended user documentation. Source, tests, release scripts, internal plans, and local verification records are excluded by an explicit allowlist.
- Production dependency audit reported zero vulnerabilities. Remaining development-tool advisories and publishing-authentication prerequisites are described in [release operations](releasing.md).
- Actual hosted runs and publication results are available in [GitHub Actions](https://github.com/Teachmetech/MicroPal/actions) and [GitHub Releases](https://github.com/Teachmetech/MicroPal/releases). Prepared store workflows alone do not establish a live store listing. Cross-platform CI does not establish physical-board compatibility on each operating system.

## Serial-port conflict recovery — 2026-10-09

Version 0.2.1 adds recovery to explicit Connect on macOS/Linux. Automated workflow tests cover precise busy-error matching, managed REPL release, external-process consent, cancellation, changed/reused process identities, approved owner subsets, trust revocation, a single retry, and failures after connection. Backend tests cover literal paths and macOS aliases, native command output, same-user managed REPL classification, signal revalidation, bounded termination, and separately requested force release.

| Check | Result |
| --- | --- |
| TypeScript, ESLint, tests, bundle build (`npm run check`) | Passed; 398 tests across 16 suites |
| VS Code 1.140.0 development host | Passed; activation, 19 commands, configuration defaults, Output, Disconnect, filesystem registration |
| Cursor (VS Code API 1.128.0) development host | Passed; same smoke check |
| Native macOS disposable PTY integration | Passed; exact owner inspection, SIGTERM, separately requested SIGKILL, confirmed closure, disappeared port node |
| Independent recovery/integration code review | Passed; no remaining actionable findings |

On the user's macOS machine, a surviving MicroPal-managed `mpremote ... repl` worker was identified holding `/dev/cu.EXAMPLE`. After revalidating its exact command, user, and selected-port ownership, only that worker received SIGTERM. A subsequent bounded `mpremote connect /dev/cu.EXAMPLE resume exec pass` completed successfully. This verifies a real MicroPython connection after release; no firmware was flashed or device files modified.

The disposable PTY integration (`npm run test:port-release`) exercises the real `lsof`/`ps` inspector and termination against its own temporary child processes. It never opens the ESP32. Regression coverage includes stock macOS lsof 4.91 descriptor fields, mount-warning continuations, and disappearance diagnostics with usage boilerplate; missing ports are verified with filesystem metadata rather than interpreting an unknown tool failure as an unowned port. Windows recovery is a manual-close fallback; Linux execution and a real external GUI serial monitor remain on the manual checklist.

## Writable ESP32 filesystem — 2026-10-09

Verified version 0.2.0 locally on macOS:

| Check | Result |
| --- | --- |
| TypeScript, ESLint, tests, bundle build (`npm run check`) | Passed; 301 tests across 14 suites |
| VS Code 1.140.0 development host | Passed; activation, 19 commands, settings, Output, Disconnect, writable provider registration |
| Cursor (VS Code API 1.128.0) development host | Passed; same 19-command smoke check |
| Native filesystem fixture in VS Code 1.140.0 | Passed; three host activations and two session restorations |
| Native filesystem fixture in Cursor 1.128.0 | Passed; same filesystem and lifecycle flow |

The isolated fixture bundles the real manager, provider, Explorer controller, and session persistence with a disk-backed fake board. It starts from one local folder, mounts ESP32 Files beneath it, survives the workspace transition and an explicit window reload, and verifies restoration without a REPL probe. It exercises binary create/read/write/rename/recursive delete, recursive copies and moves between providers, native Explorer Copy/Paste in both directions, text editor edits and saves, and clean-editor refresh after an external same-size write with an unchanged board clock. It also verifies that stale saves preserve dirty edits and board bytes, and that explicit disconnect removes the durable descriptor so a fresh Explorer cannot restore it.

Unit tests additionally cover Node Buffer ownership, create/overwrite policies, nested directory events, future/unchanged board timestamps, typed filesystem errors, URI confinement, trust/session changes during awaited work, cancelled queued edits, no-poll watches, explicit transfer dialogs, durable revocation, and a delayed mount write racing with disconnect. Transport tests execute generated Python against temporary host directories, including failed uploads preserving the original destination and binary content exceeding 1 MiB.

Run `npm run test:filesystem:host -- code` or `npm run test:filesystem:host -- cursor` to repeat the isolated native filesystem fixture. It uses a temporary profile, local folder, and fake board, and does not open a serial device.

No physical ESP32 filesystem operation or actual drag gesture was tested for this release. Hardware transfers, MicroPython filesystem overwrite semantics, disconnect recovery, Windows/Linux serial behavior, and modifier-key drag acceptance remain on the [manual checklist](manual-testing.md). Editor fixtures validate native copy/paste and move operations rather than physical hardware compatibility.

## Managed tool setup — 2026-10-09

Verified locally on macOS arm64 with Node 26.7.0 and Python 3.11.13:

| Check | Result |
| --- | --- |
| TypeScript, ESLint, bundle build (`npm run check`) | Passed |
| Unit/process/transport/workflow tests | 197 passed across 10 suites |
| Real managed installation (`npm run test:tools`) | Passed; esptool 5.0.2 and mpremote 1.29.0 |
| VS Code 1.101.2 development host | Passed; activation, 15 commands, settings, Output, Disconnect |
| Cursor (VS Code API 1.128.0) development host | Passed; same 15-command smoke check |
| VSIX packaging and archive inspection | Passed |

The real installation used disposable storage with spaces in its path. It verified both executable version commands, active-environment reload, reuse without reinstalling, and preservation after a pre-cancelled repair. A conflicting inherited pip configuration (`no-index = true`) did not affect the installation. Successful smoke runs removed their installed environments. The initial sandboxed download failed because network access was restricted; the network-enabled retry passed.

Automated tests additionally cover Python discovery/version requirements, Windows path layout and pip null-device configuration, explicit overrides, missing/broken environments, manifest confinement, repair success/failure, cancellation during setup, confirmed subprocess closure before cleanup, disposal, and pending device-command races. Independent code review found no remaining significant blockers. Editor checks used isolated temporary profiles; they verified registration and defaults, not interactive setup or physical serial operations.

No board was accessed or flashed. Actual setup on Windows/Linux, the Node 22 CI matrix, and hardware/interactive acceptance remain on the [manual checklist](manual-testing.md). Users still provide Python 3.10+ with venv/ensurepip; managed tools are downloaded only after an explicit setup action. No Marketplace release has been published.

## MicroPal rename and firmware flashing — 2026-10-08

Verified locally on macOS arm64 with Node 26.7.0:

| Check | Result |
| --- | --- |
| TypeScript, ESLint, bundle build (`npm run check`) | Passed |
| Unit/process/transport/workflow tests | 150 passed across 7 suites |
| VS Code 1.101.2 development host | Passed; activation, 13 commands, settings, Output, Disconnect |
| Cursor (VS Code API 1.128.0) development host | Passed; same 13-command smoke check |

The tests cover esptool argument construction, chip-specific defaults, input validation, opt-in full erase, literal paths, streaming/cancellation forwarding, firmware wizard confirmation/cancellation, and serial ownership handoff. Flashing can start without a MicroPython probe; pending operations and discovery are invalidated, prior serial owners must close, and completion remains disconnected.

The sandboxed VS Code launch did not produce a report. Retrying with an isolated temporary profile outside the sandbox passed. No physical board was flashed. Actual chip/image compatibility, bootloader entry, USB re-enumeration, and write/erase/recovery behavior remain on the [manual checklist](manual-testing.md). The extension requires separately installed esptool 5.x.

## Initial scaffold — 2026-10-02

Verified locally on macOS arm64, with Node 26.7.0 and Python 3.11.13:

| Check | Result |
| --- | --- |
| TypeScript strict checking | Passed |
| ESLint | Passed, no warnings |
| Unit/process/transport tests | 83 passed across 5 suites |
| Extension bundle | Passed |
| VSIX packaging and archive inspection | Passed |
| npm dependency advisory check | Zero known vulnerabilities at installation/update time |
| VS Code 1.101.2 development host | Passed |
| Cursor 3.22.7 (VS Code API 1.128.0) development host | Passed |

The editor smoke test verifies development-extension discovery and activation, all 12 command registrations, configuration defaults, opening Output, and Disconnect without hardware. The test uses an isolated temporary profile with the bundled examples folder open. Cursor's empty-window mode did not expose the development extension, so both the test and F5 configuration now open that sample workspace. An earlier isolated Cursor startup also failed in its built-in Git integration; the smoke profile disables that unrelated integration.

Real subprocess tests cover argument preservation, streaming, nonzero exits, missing/invalid executables, timeouts, cancellation and confirmed process closure. Manager tests cover exclusive ownership, disconnect races, identity matching, port renumbering, and failed REPL termination. Transport tests execute generated filesystem code against a temporary host filesystem; this validates construction and parsing, not the MicroPython runtime or hardware.

Not verified: a physical ESP32/ESP32-S3, real serial REPL input/teardown, firmware-dependent reset behavior, Windows/Linux hardware, or execution of the GitHub Actions matrix. CI is configured for Node 22 on macOS/Linux/Windows, but has not been run remotely. The [manual checklist](manual-testing.md) records the outstanding acceptance work.

No repository has been pushed and no Marketplace release has been published. The local publisher identifier must be replaced with an owned publisher before public distribution through a marketplace.
