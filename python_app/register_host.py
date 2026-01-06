# register_host.py
import json
import os
import sys
from pathlib import Path

try:
    import winreg  # type: ignore
except ImportError:
    raise RuntimeError("This script must be run on Windows (winreg not available).")


HOST_NAME = "com.spoon.connector"
REG_PATH = fr"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"


def die(msg: str, code: int = 1):
    print(f"[ERROR] {msg}", file=sys.stderr)
    sys.exit(code)


def main():
    # 1) manifest 경로 결정 (이 파일 위치 기준으로 루트의 host_manifest.json을 찾음)
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent  # python_app/.. == project root
    manifest_path = project_root / "host_manifest.json"

    if not manifest_path.exists():
        die(f"host_manifest.json not found: {manifest_path}")

    # 2) manifest JSON 기본 검증 (형식/필수키)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        die(f"Failed to read/parse manifest JSON: {e}")

    required_keys = ["name", "path", "type", "allowed_origins"]
    for k in required_keys:
        if k not in manifest:
            die(f"Manifest missing required key '{k}'")

    if manifest.get("name") != HOST_NAME:
        die(f"Manifest name mismatch. expected='{HOST_NAME}', actual='{manifest.get('name')}'")

    # 3) manifest 안의 실행 경로(path)가 실제 존재하는지 체크
    exec_path = manifest.get("path")
    if not isinstance(exec_path, str) or not exec_path.strip():
        die("Manifest 'path' is empty or not a string.")

    # JSON의 \\ 는 읽으면 \ 로 해석됨. 그대로 Path로 검사 가능.
    exec_file = Path(exec_path)
    if not exec_file.exists():
        die(f"Manifest 'path' does not exist: {exec_file}")

    # 4) 레지스트리 등록 (HKCU)
    try:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_PATH)
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
        winreg.CloseKey(key)
    except Exception as e:
        die(f"Failed to write registry: {e}")

    print("[OK] Native Messaging host registered.")
    print(f"  Host: {HOST_NAME}")
    print(f"  Registry: HKCU\\{REG_PATH}")
    print(f"  Manifest: {manifest_path}")
    print(f"  Exec path(from manifest): {exec_file}")


if __name__ == "__main__":
    main()
