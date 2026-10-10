# Editable ESP32 filesystem

The Explorer shows local workspace folders first and an `ESP32 Files` root below them. A writable `micropal` FileSystemProvider gives device files normal text editors, save, new file/folder, rename, delete, copy/paste, and native Explorer transfers. The MicroPal activity view remains a shortcut to this Explorer and device commands.

## Implementation

1. Add binary-safe transport operations, structured filesystem errors, recursive folders, and staged writes that preserve existing content when transfer fails.
2. Serialize every operation through DeviceManager without taking the port away from Run or REPL. Bind documents to random connection sessions; reject operations from older sessions. Persist revocation of old mount descriptors so a later editor reload cannot restore an explicitly ended session.
3. Implement the provider with URI validation, workspace trust checks, typed VS Code errors, and file/parent change events.
4. Mount the provider after local folders. Persist the exact session before workspace changes; after an extension-host restart, restore only a matching USB serial identity, without a REPL probe.
5. Replace snapshot editors, expose Explorer commands, document native copy/move semantics, and package the update.

## Verification

Use transport tests that execute generated Python against temporary directories; manager tests for queued cancellation, ownership, and session restoration; provider and mount contract tests; real Code and Cursor host smoke tests; and an isolated editor fixture with an in-memory board for document saves, filesystem operations, and mounting across a host restart. Physical ESP32 validation remains a manual check.

## User-visible behavior

Double-click device files and save normally. Native Explorer drag moves items; Option-drag on macOS or Ctrl-drag on Windows/Linux copies. The same actions work in both directions and with folders. Reading the board filesystem enters raw REPL and may interrupt independently running boot/main code. Explicitly started MicroPal Run/REPL sessions must first be stopped or closed. Changes made outside MicroPal require Refresh Device Files. Reconnecting explicitly creates new document identities; stale documents must be reopened or saved locally.

Cancelled uploads can leave a hidden `.micropal-upload-*.tmp` staging file, identified in Output. Filesystems that cannot replace a destination with `os.rename` reject an overwrite and preserve the existing file.
