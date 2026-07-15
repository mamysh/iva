"""Anti-ban guardrails: enforce the Telethon safety guide as SERVER behavior, so
safety does not depend on the model remembering the rules.

Wraps the ban-relevant outbound methods of the live Telethon client so every send:
  - obeys FloodWaitError: wait ``seconds * 1.3`` then retry once;
  - gets a randomized post-send delay (Telegram flags fixed-interval bots);
  - is gated by an AccountHealth circuit-breaker: after 3 FloodWaits in 24h it
    refuses further sends for 24h (raises) instead of digging the spam flag deeper.

Reads are NOT wrapped (reading is safe).

# ponytail: wraps the 3 high-level send methods, not every Telethon API — these are
# the guide's real ban vectors (cold DM, media, forwards). Raw-API writes
# (invites/joins) bypass this; the skill carries those behavioral limits. Widen the
# tuple if a new outbound vector starts mattering.
"""
import asyncio
import functools
import json
import random
import time
from pathlib import Path

from telethon.errors import FloodWaitError

_WRAPPED = ("send_message", "send_file", "forward_messages")
# Always-on pacing floor after each send; the skill layers heavier cold-DM tempo on
# top. The point is that nothing goes out at a fixed interval.
_MIN_DELAY = 2.0
_MAX_DELAY = 6.0
_FLOOD_BUFFER = 1.3
_MAX_FLOODS_PER_DAY = 3
_DAY = 24 * 3600


class GuardrailTripped(RuntimeError):
    """Raised when the circuit-breaker is open (too many FloodWaits)."""


class AccountHealth:
    """Tracks FloodWaits in a rolling 24h window and opens a circuit-breaker."""

    def __init__(self, state_path=None) -> None:
        self._state_path = Path(state_path) if state_path else None
        self._floods: list[float] = []
        self.paused_until = 0.0
        self.sends = 0
        self._load()

    def _load(self) -> None:
        if not self._state_path or not self._state_path.exists():
            return
        try:
            data = json.loads(self._state_path.read_text())
            self._floods = [float(t) for t in data.get("floods", [])]
            self.paused_until = float(data.get("paused_until", 0.0))
            self.sends = int(data.get("sends", 0))
            self._prune(time.time())
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            # A corrupt metric file must not prevent read-only access or proxy startup.
            self._floods = []
            self.paused_until = 0.0
            self.sends = 0

    def _persist(self) -> None:
        if not self._state_path:
            return
        self._state_path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        tmp = self._state_path.with_suffix(self._state_path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(
                {"floods": self._floods, "paused_until": self.paused_until, "sends": self.sends},
                separators=(",", ":"),
            )
        )
        tmp.chmod(0o600)
        tmp.replace(self._state_path)

    def _prune(self, now: float) -> None:
        self._floods = [t for t in self._floods if now - t < _DAY]

    def record_flood(self, now: "float | None" = None) -> None:
        now = time.time() if now is None else now
        self._floods.append(now)
        self._prune(now)
        if len(self._floods) >= _MAX_FLOODS_PER_DAY:
            self.paused_until = now + _DAY
        self._persist()

    def should_stop(self, now: "float | None" = None) -> bool:
        now = time.time() if now is None else now
        return now < self.paused_until

    def seconds_until_resume(self, now: "float | None" = None) -> float:
        now = time.time() if now is None else now
        return max(0.0, self.paused_until - now)


def install_guardrails(client, health=None, sleep=asyncio.sleep, rand=random.uniform):
    """Monkeypatch the client's outbound methods in place. Returns the AccountHealth.

    All wrapped methods share ONE lock so concurrent MCP tool calls serialize: sends
    are spaced by the pacing delay instead of firing simultaneously (which would be
    the exact burst the guardrail exists to prevent).
    """
    health = health or AccountHealth()
    lock = asyncio.Lock()
    for name in _WRAPPED:
        original = getattr(client, name, None)
        if original is None:
            continue
        setattr(client, name, _wrap(original, health, sleep, rand, lock))
    return health


def _wrap(original, health, sleep, rand, lock=None):
    lock = lock or asyncio.Lock()

    @functools.wraps(original)
    async def wrapper(*args, **kwargs):
        # Hold the lock across the send AND the pacing delay so a burst of concurrent
        # sends is spaced out, not just their return values.
        async with lock:
            if health.should_stop():
                mins = int(health.seconds_until_resume() // 60)
                raise GuardrailTripped(
                    f"Отправка приостановлена анти-бан защитой: {_MAX_FLOODS_PER_DAY} FloodWait "
                    f"за сутки. Возобновление через ~{mins} мин. Пока — только чтение."
                )
            attempted = False
            try:
                attempted = True
                result = await original(*args, **kwargs)
            except FloodWaitError as exc:
                health.record_flood()
                if health.should_stop():
                    raise GuardrailTripped(
                        f"FloodWait {exc.seconds}s — достигнут лимит {_MAX_FLOODS_PER_DAY}/сутки, "
                        f"стоп отправок на 24ч."
                    ) from exc
                await sleep(exc.seconds * _FLOOD_BUFFER)
                try:
                    result = await original(*args, **kwargs)  # one compliant retry
                except FloodWaitError as retry_exc:
                    health.record_flood()
                    if health.should_stop():
                        raise GuardrailTripped(
                            f"Повторный FloodWait {retry_exc.seconds}s — достигнут лимит "
                            f"{_MAX_FLOODS_PER_DAY}/сутки, стоп отправок на 24ч."
                        ) from retry_exc
                    raise
            finally:
                # Pace failures too: a caller retry-loop must not create a tight burst.
                if attempted:
                    await sleep(rand(_MIN_DELAY, _MAX_DELAY))
            health.sends += 1
            health._persist()
            return result

    return wrapper
