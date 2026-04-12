from pathlib import Path
import shutil
import time
import subprocess

DOWNLOADS = Path(r"D:\DownloadsF2")
REPO_ROOT = Path(r"D:\Projects\poe2price")
REPO_LATEST = REPO_ROOT / "docs" / "latest.json"

PATTERN = "poe2_trade_export_*.json"
WAIT_SECONDS = 2
GIT_BRANCH = "main"


def run(cmd, cwd=None):
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        shell=False,
    )


def find_latest_export(downloads: Path):
    files = sorted(
        downloads.glob(PATTERN),
        key=lambda p: p.stat().st_mtime,
        reverse=True
    )
    return files[0] if files else None


def git_publish():
    status = run(
        ["git", "status", "--porcelain", "--", "docs/latest.json"],
        cwd=REPO_ROOT
    )
    if status.returncode != 0:
        print("git status failed:")
        print(status.stderr.strip() or status.stdout.strip())
        return 1

    if not status.stdout.strip():
        print("No change in docs/latest.json, skipping git commit/push.")
        return 0

    add = run(["git", "add", "docs/latest.json"], cwd=REPO_ROOT)
    if add.returncode != 0:
        print("git add failed:")
        print(add.stderr.strip() or add.stdout.strip())
        return 1

    commit = run(
        ["git", "commit", "-m", "Update latest PoE2 prices"],
        cwd=REPO_ROOT
    )
    if commit.returncode != 0:
        print("git commit failed:")
        print(commit.stderr.strip() or commit.stdout.strip())
        return 1

    push = run(["git", "push", "origin", GIT_BRANCH], cwd=REPO_ROOT)
    if push.returncode != 0:
        print("git push failed:")
        print(push.stderr.strip() or push.stdout.strip())
        return 1

    print("Git publish complete.")
    return 0


def main():
    print("Checking folder:", DOWNLOADS)
    print("Exists:", DOWNLOADS.exists())

    latest = find_latest_export(DOWNLOADS)
    if latest is None:
        print("No export files found in Downloads.")
        return 0

    time.sleep(WAIT_SECONDS)

    if not latest.exists():
        print("Latest export disappeared before copy.")
        return 1

    REPO_LATEST.parent.mkdir(parents=True, exist_ok=True)

    temp_target = REPO_LATEST.with_suffix(".json.tmp")
    shutil.copy2(latest, temp_target)
    temp_target.replace(REPO_LATEST)

    latest.unlink()
    print(f"Copied {latest.name} -> {REPO_LATEST}")

    return git_publish()


if __name__ == "__main__":
    raise SystemExit(main())