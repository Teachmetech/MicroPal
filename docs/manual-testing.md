# Manual acceptance checklist

**Hardware status: not performed.** Local editor smoke tests and real managed-tool installation results are recorded in [verification results](verification.md). The interactive and physical acceptance cases below need separate recorded results. Automated unit tests use controlled transports and local subprocesses; they do not establish compatibility with a physical ESP32, USB bridge, or firmware build. Complete and record this matrix before claiming hardware support or publishing a release.

## Record the environment

For each run, record date/commit, OS/version, editor/version, extension version, Python/mpremote/esptool versions, managed or external tool selection, board model/revision, MicroPython build, USB interface type, and whether a stable USB serial number exists. Redact actual serial numbers and personal paths from public reports.

| Platform | ESP32 via USB–UART bridge | ESP32-S3 via native USB CDC | VS Code | Cursor |
| --- | --- | --- | --- | --- |
| macOS | Not tested | Not tested | Not tested | Not tested |
| Linux | Not tested | Not tested | Not tested | Not tested |
| Windows | Not tested | Not tested | Not tested | Not tested |

Test CP210x or CH340/CH910x bridges where available, and each native USB connector/firmware configuration intended for support. A generic bridge is not proof of an ESP32. Start with a disposable project and back up board files before overwrite tests.

## Installation and editor host

- [ ] Run `npm ci`, `npm run check`, and `npm run package` with Node 22. Record the results.
- [ ] Install the generated VSIX in a clean editor profile; verify the activity bar, commands, settings, and status item appear.
- [ ] Press F5 from the repository; confirm the Extension Development Host launches the bundled extension.
- [ ] Verify an untrusted workspace cannot perform device operations. Trust the disposable project and repeat.
- [ ] Configure an absolute external mpremote path containing spaces. Confirm discovery and a command work without shell quoting tricks; clear the override afterward to test managed tools.
- [ ] Configure a missing executable and verify the failure explains installation/path checks without hanging.
- [ ] Set an unsupported baud such as 9600; verify an explicit error. Restore 115200.

## Managed tool setup and repair

- [ ] In a clean editor profile, verify `pythonPath`, `mpremotePath`, and `esptoolPath` default to empty. Activate the extension without issuing commands; verify no package download or installation begins.
- [ ] With managed tools absent, request a device command and dismiss the Set Up Tools offer. Verify no installer, network request, or device operation begins. Accept the offer on a second attempt and verify setup is explicit.
- [ ] Run **MicroPal: Set Up Tools** with Python 3.10+ and working `venv`/`ensurepip`. Verify progress/output, installation from official PyPI, and exact `mpremote 1.29.0`/esptool `5.0.2` version checks.
- [ ] Verify tools are under extension global storage `tools/env-UUID`, with `tools.json` selecting the verified generation. Confirm global Python packages and system `PATH` are unchanged; Python itself is not downloaded or bundled.
- [ ] Test Python auto-detection and an explicit `microPal.pythonPath` containing spaces. Test missing Python, Python older than 3.10, and Python without working `venv`/`ensurepip`; verify actionable failures and no active-pointer change. Confirm shell command text is not accepted as an executable path.
- [ ] Run setup/repair during a Run session and a REPL. Verify MicroPal disconnects and waits for the local process/terminal to close before managing tools, then stays disconnected without replaying work.
- [ ] Cancel during environment creation, package installation, and verification. Test an unavailable PyPI connection or package-install failure. Verify subprocess closure, useful Output, and preservation of a previously active generation.
- [ ] Run **MicroPal: Repair Tools** successfully. Verify a new generation is created at its final location and selected only after verification; older successful generations remain intact. Reload the editor and verify the active tools still run.
- [ ] Confirm a nonempty `mpremotePath` or `esptoolPath` overrides only that managed executable. Test mixed managed/external tools, clear each override to return to managed tools, and verify workspace settings cannot substitute machine-scoped executable choices.
- [ ] Confirm Connect/discovery, Run/upload/REPL, and Flash Firmware use the selected managed tools after explicit reconnection. Record real setup results separately from unit-test results, including any skipped OS/Python combinations.

## Firmware flashing

- [ ] Test the managed esptool after Set Up Tools, then test a separately installed esptool 5.x through `microPal.esptoolPath`, including a path containing spaces. Test a missing executable and an incompatible esptool version for a useful failure.
- [ ] From a disconnected board without MicroPython, select Flash Firmware and verify port selection works without a REPL probe. If native USB changes in bootloader mode, enter that mode before selecting its port.
- [ ] Verify ESP32 defaults to `0x1000` and ESP32-S3 to `0x0`; compare against the exact board's firmware page. Test a valid override and rejection of invalid/unaligned addresses, empty files, and non-binary paths.
- [ ] Dismiss each picker and the final confirmation in turn; verify esptool never starts. Check the final confirmation identifies the chip, port, image, address, and erase mode.
- [ ] Flash a board-specific combined image and verify streamed output, esptool verification, disconnected completion, and a successful subsequent explicit Connect. Verify a mismatched-chip image is rejected without using `--force`.
- [ ] On a disposable board, test full erase and verify old files/settings are removed. Check write-only mode does not request a full erase; preservation depends on the image's written sectors.
- [ ] Flash during a Run session and during REPL; verify confirmed old-process/terminal closure before esptool acquires the port. Verify Connect, Run, and another Flash cannot compete while writing.
- [ ] Cancel in progress, Disconnect, unplug, and close the editor during a write. Verify esptool terminates and releases ownership, no automatic reconnect/replay occurs, and an explicit reflash can recover partial firmware.

## Discovery and selection

- [ ] With no board attached, Connect reports no candidates without an uncaught error.
- [ ] Attach one supported board and verify its port and available metadata. Confirm before choosing a port shared with other devices.
- [ ] Attach two devices; verify explicit selection and that operations affect only the selected board.
- [ ] Set `preferredPort` to a path/COM name, then `id:USB_SERIAL_NUMBER`. Verify selection for each and behavior when it is absent.
- [ ] Leave a board program printing for at least 30 seconds while discovery monitors presence. Confirm idle discovery does not interrupt/reset it.
- [ ] Check connected status between commands while a separate serial tool can acquire the released port; close that tool before continuing.

## Files and program execution

- [ ] Run `examples/heartbeat.py` directly. Observe output in the MicroPal Output channel and a running state. Confirm it did not create a file on the board.
- [ ] Run another script that checks a variable from the prior run is absent, confirming a clean interpreter heap.
- [ ] Run a script importing a local project module before and after uploading that module; verify the missing import and then successful import.
- [ ] Stop the heartbeat. Confirm output ceases on the board, status recovers, and a new command succeeds.
- [ ] Run code with a Python exception; verify traceback output and a usable subsequent command.
- [ ] Upload a filename containing spaces and shell metacharacters supported by the host filesystem. Confirm the literal name, without unintended execution.
- [ ] Sync nested Python/assets, a hidden file, excluded `.env`/virtual-environment files, and symlinks. Check the preview, then verify included paths, skipped exclusions/symlinks, and preserved remote-only files.
- [ ] Cancel the sync confirmation; verify no upload occurs. Cancel or unplug during sync; verify an error and document partial completion rather than claiming rollback.

## Writable ESP32 Explorer

- [ ] With a trusted local project open, Connect. Verify the normal Explorer shows local folders above **ESP32 Files**. Open/close it using **Open ESP32 Files in Explorer** and **Close ESP32 Files**; local roots remain in their prior order.
- [ ] Connect without a local folder open. Verify connection still works and the Explorer action explains that a local project folder is needed. Open a local folder and mount the device root.
- [ ] Double-click a device `.py` file, edit it, and save with Cmd+S/Ctrl+S. Reopen and compare the on-device bytes. Save twice quickly with the board RTC unchanged and verify the editor sees the latest version without a false timestamp conflict.
- [ ] Create and rename files and nested folders, including spaces, Unicode, and quotes in names. Verify correct Explorer names and literal device paths. Delete files and nonempty folders only on the disposable board; confirm permanent removal.
- [ ] Copy/paste both a file and a nested folder from local to device, then back into a separate local destination. Compare all bytes, including binary/NUL/non-UTF-8 data and a file larger than 1 MiB when storage and deadlines permit. Use the editor's appropriate binary viewer instead of expecting text decoding.
- [ ] Use **Upload Files to ESP32…** with multiple local files and **Upload Folder to ESP32…** with a nested folder from the native Explorer's device-directory context menu. Use **Download from ESP32…** on files and folders and choose new local destinations. Confirm both directions retain their sources, reject existing destinations without merging folders, and cancellation does nothing.
- [ ] While an upload or download picker is open, connect a different board. Confirm accepting the original picker fails as a stale session, without writing to the new board or a local download destination.
- [ ] Option-drag on macOS or Ctrl-drag on Windows/Linux in both directions. Verify copies retain their source, destination files match, and nested folders transfer. Repeat an unmodified drag with expendable items; verify native move behavior and source removal after a successful transfer.
- [ ] Review native overwrite prompts for existing destination files. Test normal saves, Save As creating a file, create-without-overwrite conflicts, missing files, a file used as a parent directory, and a directory opened as a file. Verify useful typed errors and no false success state.
- [ ] Modify a device file using another client, then choose **Refresh Device Files** and verify Explorer/editor refresh behavior. Leave the extension idle and verify no background filesystem polling; native Explorer/editor requests are allowed to query when used.
- [ ] During an extension Run session or REPL, attempt stat/list/read/save/new-folder/rename/delete and transfer operations. Verify requests ask you to stop/close the active session and do not take ownership. Stop or close it, then retry successfully.
- [ ] Start a loop from the board's `main.py` after a physical reset, with no extension Run/REPL owner. Access **ESP32 Files** and verify the documented raw-REPL interruption behavior. Do not treat idle port enumeration as filesystem access.
- [ ] Keep a device editor dirty, Disconnect, connect a different board, then save the old document. Verify the stale save is rejected and the new board is untouched. Save the pending text locally, reopen from the current device root, and verify a new save succeeds.
- [ ] Repeat stale-document handling after an explicit reconnect to the same board and after firmware flashing. Old session URIs must remain invalid rather than following whichever board is currently selected.
- [ ] Disconnect with ESP32 Files still mounted, then reload the editor. Verify the old session cannot restore, even with the same board plugged in. Repeat after flashing and managed setup/repair. Reconnect explicitly and reopen the file to obtain a new session.
- [ ] Trigger the single-folder to multi-root workspace transition and reload the editor. With a stable USB identity, verify the saved session is restored by enumeration without a REPL probe. Explorer reads afterward may enter raw REPL. With no USB serial identity, verify the mount requires explicit reconnect; a different stable-identity board at a reused path must never restore the saved mount.
- [ ] Unplug, cancel, Disconnect, or close the editor during a direct save. Reconnect and verify the previous destination survived an incomplete transfer, while any hidden `.micropal-upload-*.tmp` staging file is identifiable and removable. Record native firmware behavior during rename separately from host-filesystem tests.
- [ ] On a device/filesystem that cannot replace an existing destination using `os.rename`, verify overwrite fails with the original retained. Test full storage and insufficient temporary staging space for useful failures.
- [ ] Interrupt a folder copy/move. Record which destination entries completed and, for a move, which source entries remain; do not claim transactional rollback.
- [ ] Attempt deleting, renaming, or overwriting the device root and accessing traversal, query-bearing, fragment-bearing, or cross-session URIs through an editor test fixture. Verify rejection without mutation. Verify an untrusted workspace blocks all filesystem operations, including a previously opened document's Save.

## REPL and ownership

- [ ] Open REPL and evaluate `1 + 1`. Verify input, output, backspace, multiline input, and Ctrl-C.
- [ ] Test Ctrl-D soft reset, Ctrl-A raw REPL, Ctrl-B friendly REPL, and mpremote exit (Ctrl-]). Verify terminal behavior on each OS.
- [ ] While REPL is open, run a file or request an upload. Confirm the old terminal closes before the next operation acquires the port.
- [ ] Close the REPL terminal manually. Confirm connection state recovers and another command works.
- [ ] While a script runs, issue Stop then Run rapidly. Confirm no overlapping serial clients and no stale completion overwrites the current state.
- [ ] Start a long operation and choose Disconnect. Verify local ownership is released before a new Connect. Disconnect alone need not interrupt board code.
- [ ] Reload/close the Extension Development Host during Run and REPL; record whether terminal cleanup releases the port. If a managed REPL survives an interrupted shutdown, verify explicit Connect recovers it on macOS/Linux. A surviving Run process must require external-owner confirmation.
- [ ] On macOS/Linux, leave a MicroPal-managed REPL alive across an extension-host restart, then Connect to its port. Verify only that REPL worker exits automatically and Connect retries successfully. Disable `autoReleasePort` and verify it requires confirmation.
- [ ] Open Thonny or an external serial monitor first, then Connect. Verify the process name/PID and **Release Port and Connect** confirmation. Cancel and verify the owner remains; confirm and verify it exits before connection retry. Do not use an application with unsaved work for this test.
- [ ] Use a disposable serial owner that ignores SIGTERM. Verify only a StillBusy timeout offers **Force Release and Connect**, cancellation leaves it alive, and explicit force consent stops the approved owner. Permission errors and changed process identities must not offer force.
- [ ] During owner inspection or either release dialog, Disconnect, change boards, or start firmware flashing. Verify the pending recovery sends no further signals and never retries the old connection. Start Connect twice and verify only one recovery workflow proceeds.
- [ ] On Windows or with `lsof`/`ps` unavailable, verify a useful manual-close message without process termination. Test Linux inspection separately from macOS; include a macOS process holding the other `/dev/cu.*` or `/dev/tty.*` alias.
- [ ] Try two editor windows only to confirm the documented limit: ownership is not coordinated across instances. Close the second owner before normal testing.

## Reset, unplug, and reconnect

- [ ] ESP32 via USB–UART: press hardware reset while idle, while running, and during REPL. Observe whether the port stays present; verify no automatic replay and a successful next explicit command.
- [ ] ESP32-S3 native USB: soft reset and press hardware reset. Observe port disappearance/path changes, identity-based rediscovery, and interpreter readiness for the next command.
- [ ] Unplug during discovery, connect/probe, Run, upload, filesystem read, and REPL. Verify a recoverable status with no stuck busy/ownership state.
- [ ] Replug the same stable-identity board under a different path. Confirm it reconnects without resetting, rerunning, uploading, or reading files automatically.
- [ ] While the selected board is absent, plug in a different board at a reused path. When USB identities are available, verify it is not silently selected.
- [ ] Test a device without a USB serial identity. Document path fallback and explicitly select the new path when it changes.
- [ ] Turn `autoReconnect` off; verify no automatic reacquisition. Turn it on and verify the expected presence behavior.
- [ ] Disconnect explicitly, then replug. Verify monitoring remains stopped until a user connects again.
- [ ] Enter bootloader mode. Verify an error or unavailable state instead of treating the bootloader as a usable MicroPython REPL; recover using normal board procedures.

## Record outcomes

For each failed case, keep the smallest reproduction, timestamps, relevant redacted Output content, actual vs. expected state, and whether another tool held the port. Distinguish OS enumeration delays, firmware USB configuration, and extension ownership failures. Mark skipped cases as skipped with a reason; never turn this checklist into a claimed pass based only on automated tests.
