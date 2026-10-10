"""Run from the editor, then use Stop Execution or REPL Ctrl-C to interrupt."""

import gc
import sys
import time

print("MicroPal heartbeat")
print("Platform:", sys.platform)
print("Python:", sys.version)

count = 0
while True:
    print("tick", count, "free bytes", gc.mem_free())
    count += 1
    time.sleep(1)
