import sys
import json
import struct

LOG_PATH = r"C:\chopsticks\python_app\native_log.txt"

def log(msg):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(msg + "\n")

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    return json.loads(data.decode("utf-8"))

def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def main():
    log("=== listener started ===")
    send_message({"status": "listener_started"})

    while True:
        msg = read_message()
        if msg is None:
            log("stdin closed")
            break

        log(f"recv: {msg}")
        send_message({"echo": msg})

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {repr(e)}")
        raise
