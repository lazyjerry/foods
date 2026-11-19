"""插畫檔名只增不改不刪（AGENTS.md〈插畫檔案〉）的檢查，由 scripts/check.sh 呼叫，也可單獨跑：

    python3 scripts/check_illustrations.py

照片紀錄以 illust/<檔名> 直接引用 public/img/illustrations/ 的原檔（src/media.js），
檔案改名或刪掉，引用它的照片就會破圖。檢查：
1. git 歷史上曾經加進 public/img/illustrations/ 的檔名，現在都還在（改名在 git 裡是「加新的、刪舊的」，一樣會被抓到）。
2. 這些檔名與目前目錄裡的檔名，都符合 src/media.js 的 ILLUST_KEY，否則舊照片的 key 會被視為無效、讀不到。
不是 git repo 時跳過第 1 項並警告；shallow clone 時歷史不完整，第 1 項只能檢查已抓下來的部分。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = "public/img/illustrations"


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=True).stdout


def main():
    errors = []
    current = sorted(p.name for p in (ROOT / DIR).iterdir() if p.is_file() and not p.name.startswith("."))

    try:
        added = git("log", "--diff-filter=A", "--name-only", "--format=", "--", DIR)
        ever = sorted({Path(line).name for line in added.splitlines() if line.strip()})
        if git("rev-parse", "--is-shallow-repository").strip() == "true":
            print("警告：shallow clone，git 歷史不完整，只檢查已抓下來的部分", file=sys.stderr)
    except (FileNotFoundError, subprocess.CalledProcessError):
        ever = []
        print("警告：不是 git repo 或沒有 git，跳過「歷史上的插畫都還在」檢查", file=sys.stderr)

    for name in ever:
        if not (ROOT / DIR / name).is_file():
            errors.append(f"插畫被改名或刪除：{DIR}/{name}（已有照片可能引用 illust/{name}，請還原這個檔）")

    src = (ROOT / "src/media.js").read_text(encoding="utf-8")
    m = re.search(r"^const ILLUST_KEY = /(.+)/;$", src, re.M)
    if not m:
        errors.append("src/media.js 找不到 ILLUST_KEY，無法確認插畫 key 格式")
    else:
        pattern = re.compile(m.group(1).replace("\\/", "/"))
        for name in sorted(set(ever) | set(current)):
            if not pattern.fullmatch(f"illust/{name}"):
                errors.append(f"插畫檔名不符合 src/media.js 的 ILLUST_KEY：{name}（引用它的照片會讀不到）")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"插畫檔名檢查通過：歷史上 {len(ever)} 個檔名都還在，目前 {len(current)} 個檔名都符合 key 格式")
    return 0


if __name__ == "__main__":
    sys.exit(main())
