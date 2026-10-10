# V1 implementation plan

Goal: a locally runnable, permissively licensed ESP32 extension with tested serial ownership and a packageable release scaffold.

Architecture and scope are in [architecture.md](architecture.md). Implementation uses TypeScript, VS Code 1.95+ APIs, mpremote, Node child processes, Vitest and esbuild. No native Node serial dependency or custom firmware protocol is required.

1. Establish the manifest, extension-host launch configuration, typed transport contracts and build/lint/test/package scripts.
2. Implement a process runner with real subprocess tests for safe arguments, streaming, bounded buffers, abort, timeout and exit synchronization.
3. Implement mpremote discovery, commands, structured filesystem responses and native-terminal launch, with construction/parsing tests before implementation.
4. Implement the device manager with controlled transport tests for exclusive ownership, state transitions, cancellation, presence monitoring, serial identity matching and explicit disconnect.
5. Wire commands, file snapshots/downloads, cached tree, status bar and sync planning. Test sync exclusion/traversal and terminal handoff behavior.
6. Add community/security/license documents, example, cross-platform CI and manual hardware acceptance checklist.
7. Run typecheck, lint, full tests and bundling. Inspect a packaged VSIX and independently review cancellation, disconnect races and command safety. Report hardware/editor verification limits accurately.

Review focus: a USB path reassigned to a different board; disconnect during a probe; refresh while user code owns the port; local paths containing spaces or shell syntax; a subprocess that ignores termination. These require tests at their respective boundaries.
