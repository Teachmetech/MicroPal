# Architecture

MicroPal is a desktop TypeScript extension for local MicroPython ESP32/ESP32-S3 development in VS Code and compatible Cursor releases. Version 0.2.1 adds recovery for serial-port conflicts alongside the native writable filesystem, explicit device selection, and exclusive serial ownership within one extension host.

## Boundaries

- `src/extension.ts` wires VS Code commands, settings and lifecycle.
- `src/ui/deviceFileSystem.ts` adapts binary device operations into a writable VS Code `FileSystemProvider`.
- `src/ui/deviceExplorer.ts` mounts the device after local workspace roots and restores a verified session after editor-host restarts.
- `src/ui/deviceSessionPersistence.ts` removes saved descriptors when a connection session ends, so a reload cannot revive a stale document's permissions.
- Other `src/ui/` modules contain the status bar, device shortcut view, setup/flashing workflows, and real-terminal REPL integration.
- `src/core/deviceManager.ts` owns state transitions, serialization, cancellation and presence-based reconnect.
- `src/core/projectSync.ts` plans uploads with exclusion patterns and no symlink traversal.
- `src/transport/mpremote.ts` implements the transport contract and constructs argument arrays.
- `src/transport/esptool.ts` validates firmware inputs and constructs shell-free esptool 5.x flash commands.
- `src/transport/processRunner.ts` owns child process creation, bounded output, deadlines and confirmed termination.
- `src/core/types.ts` keeps the manager independent of VS Code and any specific transport.
- The managed tool service owns Python discovery, private environment installation, verification, and active-tool resolution; setup/repair UI reports progress and cancellation.

## Managed tools

`microPal.setupTools` (**MicroPal: Set Up Tools**) and `microPal.repairTools` (**MicroPal: Repair Tools**) are explicit installation actions. Activation never starts an installer or network request. A device command that needs missing managed tools offers Set Up Tools. Setup/repair disconnect MicroPal and wait for active device operations to release serial ownership before managing tools; they do not resume those operations afterward.

The user provides Python 3.10+ with `venv` and `ensurepip`; MicroPal does not bundle Python. Machine-scoped `microPal.pythonPath` defaults to empty for detection, or selects a Python executable directly. No setting accepts shell command text. A private virtual environment installs `mpremote==1.29.0` and `esptool==5.0.2`, plus dependencies, from official PyPI. The environment's Python and tool executables are invoked through argument arrays, without shell activation, global package installation, or system `PATH` edits. Output is streamed and installation supports cancellation.

Installation uses pip's isolated mode and sets `PIP_CONFIG_FILE` to Python's platform-specific null device, disabling configuration files that could add indexes or redirect installation. See the [pip configuration reference](https://pip.pypa.io/en/stable/topics/configuration/#pip-config-file).

Extension global storage contains a `tools/` directory with immutable `env-UUID` generations and an atomic `tools.json` active pointer. Environments are created at their final paths because installed scripts embed absolute interpreter paths. Setup/repair verify both pinned tool versions before switching the pointer. A failed or cancelled attempt leaves the previous active generation selected; earlier successful generations are retained. Repair builds a fresh generation instead of modifying the active environment in place.

`microPal.mpremotePath` and `microPal.esptoolPath` default to empty, selecting the managed tools. A nonempty machine/User-scoped override takes precedence for that executable. This supports external installations while keeping normal use independent of editor `PATH` and global Python packages.

## Serial ownership and state

A connected state means the selected port is available for commands; it does not mean an idle serial handle is held. Bounded commands release their process before completion. A running script or interactive REPL owns the port until it exits or an explicit command ends it. New work waits for that exit. Closing a local process alone is not a board stop; Stop additionally enters raw REPL and interrupts the board using `resume exec pass`.

`createConnectCommand` catches only selected-port open/busy failures after the manager has released its tracked owner. `SerialPortOwners` uses bounded `lsof` and `ps` subprocesses on macOS/Linux, checking both macOS serial aliases. Automatic SIGTERM is limited to same-user REPL workers whose Python and mpremote paths match one MicroPal managed environment. External owners require confirmation; a typed StillBusy timeout alone can offer separate SIGKILL consent. PID, UID, start time, full command, and current port ownership are revalidated before each signal; a changed owner aborts recovery. The UI exposes only display names/PIDs. Connection revisions, cancellation signals, and a single active workflow prevent stale dialogs from releasing a newer connection. The actual Connect retries once; post-connect Explorer errors cannot trigger process termination. Windows has a manual-close fallback.

Discovery only runs `mpremote connect list`; it never opens the port. After disappearance, reconnection matches USB serial identity where available (otherwise the exact manually selected path). Presence restoration does not run a probe, reset, filesystem query, or replay a previous command. Explicit Disconnect cancels pending work and prevents reconnection. Native Explorer requests are separate filesystem operations and may query mounted roots or open documents.

Real VS Code terminals provide the OS terminal needed by mpremote's console implementation. The extension uses an executable and argument array, never shell text, and waits for terminal/process exit before transferring ownership. Ownership across different applications or editor windows remains the user's responsibility.

## Scope and tradeoffs

CLI invocations are easier to install and audit than native serial bindings or a private copy of the MicroPython wire protocol. They do incur startup overhead and cannot offer custom baud: the upstream CLI uses 115200. The setting is present but unsupported values fail explicitly. A future alternative transport can implement other baud rates without changing editor commands or manager policy.

`resume` makes file/query/stop commands independent of mpremote version differences in automatic soft reset. Run explicitly starts with `soft-reset`. Filesystem operations enter raw REPL and can interrupt independently running board code. They refuse to take ownership from an active MicroPal Run or REPL. Upload and sync overwrite matching remote files, preserve other files and never delete remote files. Sync previews file count/size before asking the user to proceed.

## Writable device filesystem

`DeviceFileSystem` implements the `micropal` URI scheme. The URI authority is a random connection session; the path is an absolute device path. Provider entry points validate scheme, authority, path, workspace trust, and connection availability. Queries, fragments, traversal/control characters, cross-session renames, and destructive operations on `/` are rejected. Each manager request carries the expected session and checks it again inside the serial queue; provider checks after awaited work prevent results from an old session appearing on a new one.

Files are read and written as bytes. Normal editors save through `writeFile`, with `create` and `overwrite` enforced, and standard Explorer commands use directory creation, deletion, and rename. Structured backend errors become the corresponding VS Code filesystem errors; unexpected errors remain visible. The adapter emits batched resource/parent events after successful mutations and tracks host mutation times so repeated saves/renames advance modification times even with an unchanged board RTC. Its `watch` implementation does not poll or acquire hardware. **Refresh Device Files** invalidates the active root for external changes.

Writes transfer into a unique hidden `.micropal-upload-*.tmp` file beside the destination and rename only after the transfer succeeds. Cancelled or interrupted operations can leave staging files, and their paths are reported where possible. Replacement depends on the device filesystem's `os.rename` semantics; an unsupported overwrite fails while retaining the original file. Folder transfers are not atomic and can complete only partly before an error.

The native Explorer contains local workspace folders first and an **ESP32 Files** root last. A local folder is required for this layout. **Open ESP32 Files in Explorer** adds or reveals the current mount; **Close ESP32 Files** removes it. Native filesystem support gives file/folder transfers in both directions without a custom drop target: drag normally moves, Option-drag on macOS or Ctrl-drag on Windows/Linux copies, and copy/paste retains the source. Project-sync exclusions do not filter selected native transfers.

Explicit **Upload Files to ESP32…**, **Upload Folder to ESP32…**, and **Download from ESP32…** actions also use `workspace.fs.copy` for files and recursive folder transfers. Dialog selections must be local paths. Capturing and revalidating the original device URI across the dialog prevents a new connection from retargeting the request. Existing destinations are rejected before copy, and the copy request uses `overwrite: false`.

Adding a second workspace root can restart the extension host. Before changing workspace folders, the mount controller persists the exact session and selected USB metadata in extension global state. On restart it restores only a matching stable USB serial identity using port enumeration, without a REPL probe; it then allows native Explorer filesystem requests. Ports without a USB serial identity require an explicit reconnect. An explicit new Connect, Disconnect, or firmware flash invalidates prior device document identities, so stale dirty documents must be saved locally or reopened from the current mount. Device identity is not cryptographic authentication.

Session changes also revoke the previous session's persisted mount descriptor. Commands and deactivation wait for pending revocations. During an ordinary host reload, the persistence observer stops before manager cleanup, retaining an active session's descriptor while preserving all explicit revocations.

Firmware flashing uses the same manager queue and process ownership boundary, without a MicroPython probe. It invalidates existing work, waits for confirmed serial closure, suspends presence monitoring, and enters `flashing`. Disconnect and progress cancellation terminate esptool before ownership is released. Completion leaves the manager disconnected; Connect is explicit. The UI confirms the chip, local image, address, and erase mode. ESP32 defaults to `0x1000`; ESP32-S3 defaults to `0x0`, with a validated override for board-specific firmware. Variable debugging, GPIO inspection and remote/WebREPL connections are deferred.

## Verification

Unit tests exercise state transitions, ownership/session races, byte-preserving filesystem operations, provider event/error contracts, Explorer mounting/restoration, CLI argument construction, malformed device responses, subprocess timeout/cancellation, sync selection, and managed setup decisions. Generated filesystem Python is exercised against temporary host directories; this does not establish MicroPython filesystem compatibility. Real package installation and editor/hardware acceptance require separate recorded checks in `manual-testing.md`. The CI and Release workflow checks Node 22 on Linux, macOS, and Windows before production releases; hosted results are recorded in GitHub Actions. Physical-board acceptance remains separate.

Official references: [mpremote released docs](https://docs.micropython.org/en/v1.29.0/reference/mpremote.html), [mpremote connect source](https://github.com/micropython/micropython/blob/v1.29.0/tools/mpremote/mpremote/commands.py), [VS Code terminal API](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions).
