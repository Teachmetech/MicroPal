# Automatic ESP32 output and official MicroPython flashing

The extension should show ongoing ESP32 output after Connect and offer official firmware discovery and download inside Flash Firmware. Keep the existing native Explorer, local BIN workflow, explicit flash confirmation, managed tool setup, and no automatic code replay.

1. Add a passive managed-Python serial reader and a low-priority console owner in DeviceManager. Connect uses reader readiness when available; foreground work cancels and waits for the reader to close. Resume only when the queue is idle and the same session remains selected. Suppress automatic retries after reader failure. Add lifecycle/race and reader tests first.
2. Add a firmware service for the official ESP32_GENERIC and ESP32_GENERIC_S3 pages. Parse supported stable combined BIN links, bound HTTPS requests and files, validate chip headers, and save downloads atomically with local SHA-256 provenance. Test parsing, malformed responses, cancellation, cleanup, and metadata validation without hardware.
3. Extend the flash wizard with official/local source, supported board variant and version choices, cancellable catalog/download progress, known official addresses, and the existing erase and destructive confirmation steps. Add workflow tests before implementation; keep serial acquisition after confirmation.
4. Wire default-on microPal.autoShowOutput, configuration refresh, console output, and the idle firmware service. Update README, architecture, acceptance checks, and every change in Unreleased notes.
5. Run focused tests, the full check, isolated editor-host smoke tests, and a non-flashing official-download smoke check. Independently review serial ownership and download/UI behavior. Physical-board behavior requires separate hardware acceptance; never flash hardware as an implementation test.

No dependencies or published versions change. Public release automation selects a new version after reviewed integration into production.
