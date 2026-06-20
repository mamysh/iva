#!/usr/bin/env python3
"""Run chigwell/telegram-mcp over Streamable HTTP or SSE for eve connections."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


PROJECT_ENV = _read_env_file(ROOT / ".env")


def _env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name) or PROJECT_ENV.get(name) or default


def _project_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else ROOT / path


DATA_DIR = _project_path(_env("ASSISTANT_DATA_DIR", "data") or "data")
MCP_DIR = _project_path(_env("TELEGRAM_MCP_DIR", str(DATA_DIR / "telegram-mcp")) or str(DATA_DIR / "telegram-mcp"))
VENV_PYTHON = MCP_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _reexec_with_venv() -> None:
    if os.environ.get("TELEGRAM_MCP_NO_REEXEC") == "1":
        return
    if not VENV_PYTHON.exists():
        return
    try:
        current = Path(sys.executable).absolute()
        target = VENV_PYTHON.absolute()
    except OSError:
        return
    if current == target:
        return
    env = os.environ.copy()
    for key, value in PROJECT_ENV.items():
        env.setdefault(key, value)
    env["TELEGRAM_MCP_NO_REEXEC"] = "1"
    os.execvpe(str(target), [str(target), str(Path(__file__).resolve()), *sys.argv[1:]], env)


_reexec_with_venv()

if not MCP_DIR.exists():
    raise SystemExit(
        f"telegram-mcp checkout not found: {MCP_DIR}\n"
        "Run `npm run telegram:mcp:setup` first, or set TELEGRAM_MCP_DIR."
    )

sys.path.insert(0, str(MCP_DIR))

try:
    from dotenv import load_dotenv
except ImportError as exc:
    raise SystemExit(
        "python-dotenv is missing. Run `npm run telegram:mcp:setup` to install telegram-mcp dependencies."
    ) from exc

load_dotenv(MCP_DIR / ".env")
load_dotenv(ROOT / ".env", override=True)

os.environ.setdefault("TELEGRAM_EXPOSED_TOOLS", "read-only")

missing = [
    name
    for name in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH")
    if not (os.environ.get(name) or "").strip()
]
has_session = any(
    (os.environ.get(name) or "").strip()
    for name in ("TELEGRAM_SESSION_STRING", "TELEGRAM_SESSION_NAME")
)
has_labeled_session = any(
    key.startswith(("TELEGRAM_SESSION_STRING_", "TELEGRAM_SESSION_NAME_")) and value.strip()
    for key, value in os.environ.items()
)
if missing or not (has_session or has_labeled_session):
    needed = ", ".join(missing + ([] if has_session or has_labeled_session else ["TELEGRAM_SESSION_STRING"]))
    raise SystemExit(
        f"Telegram MCP credentials are incomplete: {needed}.\n"
        "Fill them in .env, or run `npm run telegram:mcp:session -- --qr` to generate a session string."
    )

try:
    import nest_asyncio
    from telegram_mcp import runtime as _runtime
    from telegram_mcp.runtime import clients, mcp
    from telegram_mcp.runner import _connect_authorized_client
    import telegram_mcp.tools  # noqa: F401 - registers tools via decorators
except Exception as exc:
    raise SystemExit(f"Could not import chigwell/telegram-mcp from {MCP_DIR}: {exc}") from exc


def _roots_from_env() -> list[str]:
    raw = (os.environ.get("TELEGRAM_MCP_ALLOWED_ROOTS") or "").strip()
    if not raw:
        return []
    return [part for part in raw.replace(",", os.pathsep).split(os.pathsep) if part]


def _configure_server() -> str:
    roots = sys.argv[1:] or _roots_from_env()
    _runtime._configure_allowed_roots_from_cli(roots)
    _runtime._apply_exposed_tools_mode()

    mcp.settings.host = os.environ.get("TELEGRAM_MCP_HOST", "127.0.0.1")
    mcp.settings.port = int(os.environ.get("TELEGRAM_MCP_PORT", "8765"))
    mcp.settings.streamable_http_path = os.environ.get("TELEGRAM_MCP_PATH", "/mcp")
    mcp.settings.sse_path = os.environ.get("TELEGRAM_MCP_SSE_PATH", "/sse")
    mcp.settings.message_path = os.environ.get("TELEGRAM_MCP_MESSAGE_PATH", "/messages/")

    transport = os.environ.get("TELEGRAM_MCP_TRANSPORT", "streamable-http").strip().lower()
    if transport not in {"streamable-http", "sse"}:
        raise SystemExit("TELEGRAM_MCP_TRANSPORT must be streamable-http or sse.")
    return transport


async def _main() -> None:
    transport = _configure_server()
    labels = ", ".join(clients.keys())
    print(f"Starting {len(clients)} Telegram client(s) ({labels})...", file=sys.stderr)

    try:
        await asyncio.gather(
            *(_connect_authorized_client(label, client) for label, client in clients.items())
        )

        print("Warming entity caches (background)...", file=sys.stderr)

        async def _warm_caches() -> None:
            try:
                await asyncio.gather(*(client.get_dialogs() for client in clients.values()))
                print("Entity caches warmed.", file=sys.stderr)
            except Exception as exc:
                print(f"Entity cache warm failed: {exc}", file=sys.stderr)

        asyncio.create_task(_warm_caches())

        path = mcp.settings.streamable_http_path if transport == "streamable-http" else mcp.settings.sse_path
        print(
            f"Telegram MCP ready on http://{mcp.settings.host}:{mcp.settings.port}{path} "
            f"({transport}, tools={os.environ.get('TELEGRAM_EXPOSED_TOOLS')})",
            file=sys.stderr,
        )

        if transport == "sse":
            await mcp.run_sse_async()
        else:
            await mcp.run_streamable_http_async()
    except Exception as exc:
        print(f"Error starting Telegram MCP HTTP server: {exc}", file=sys.stderr)
        if isinstance(exc, sqlite3.OperationalError) and "database is locked" in str(exc):
            print("Database lock detected. Please ensure no other instances are running.", file=sys.stderr)
        raise
    finally:
        await asyncio.gather(*(client.disconnect() for client in clients.values()), return_exceptions=True)


def main() -> None:
    nest_asyncio.apply()
    asyncio.run(_main())


if __name__ == "__main__":
    main()
