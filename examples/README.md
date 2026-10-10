# Heartbeat example

Open `heartbeat.py` on a MicroPython board and choose **MicroPal: Run Current File**. It prints board information and a counter every second without using board-specific GPIO pins. Use **Stop Execution** to interrupt it.

Run streams output to the extension's Output channel and does not store this file on the board. Upload the file explicitly if you want to import it later. It is deliberately not named `main.py`, so uploading it does not make it start automatically at boot.

This example requires MicroPython's `gc.mem_free()`; it is not intended for desktop CPython. No physical-board results are claimed yet.
