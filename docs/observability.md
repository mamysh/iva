# Health metrics and capacity

Iva uses one lightweight hourly systemd job rather than a monitoring daemon. `iva-observe.timer`
collects sanitized counters into `data/health-metrics.jsonl`; it does not read message text, prompts,
vault contents, credentials, or Workflow payloads.

Run the concise operator view with:

```bash
iva status
```

It reports current/peak agent RSS, service restarts, Workflow size and growth, queue depth and oldest
active age, recent successful turn/jobs/portable backup, disk and inode capacity, and swap pressure.
Use `iva doctor` for the detailed health contract and `iva logs` for diagnosis.

## Bounded baseline

The collector records no more than one sample per 55 minutes and retains at most 744 samples (31
days). The JSONL file and alert state are private `0600` derived artifacts; portable backup excludes
them because they can be rebuilt. Rotation is automatic and does not touch Workflow history.

The first seven days are baseline-only: no health alert is sent. The status view shows progress for
the 7/30-day baseline. After seven days Iva can notify the owner about low disk/inodes, swap above
90%, wedged runs, or measured Workflow growth that could fill the disk within seven days. Repeated
alerts have a 24-hour cooldown and resolved alert state is removed.

These thresholds protect capacity; they are not a retention policy. Iva never deletes Workflow
tables, waiting sessions, continuation history, vault data, tasks, or logs to make room. Investigate
growth with `iva status` and `iva doctor`, make a verified backup when appropriate, and decide on a
safe product-specific retention rule only after the 7/30-day measurements exist.

## Manual checks

```bash
systemctl --user status iva-observe.timer iva-observe.service
systemctl --user start iva-observe.service
iva status
iva doctor
```

If the collector has not run yet, `iva status` says that no samples exist. The core agent and
Telegram bridge do not depend on metrics collection, so a collector failure does not stop replies.
