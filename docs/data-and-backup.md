# Data, backup, restore, and server moves

Iva has several independent kinds of state. The tracked, sanitized inventory is
[`scripts/data-manifest.json`](../scripts/data-manifest.json); it is the machine-readable source of
truth for classification, backup method, restore order, retention, and acceptable loss.

## What a portable backup contains

| State | Portable backup | If it is missing |
|---|---|---|
| `.env` and optional Workflow environment | Yes, private | Credentials and runtime configuration must be entered again |
| Live vault, including its private Git repository and attachments | Yes | Personal memory is lost unless the separate private vault remote has it |
| Tasks, reminders, usage, Telegram offset, OAuth | Yes when present | Each missing file loses only that capability's state; OAuth can be recreated by signing in |
| Opt-in Telegram userbot token and session | Yes when present | The personal account must be authorized again; restoring the file never enables the service |
| Local Workflow state | Yes, with every writer stopped | Conversation/continuation state is lost |
| PostgreSQL Workflow state | Yes, `pg_dump` custom format verified by `pg_restore --list` | Conversation/continuation state is lost |
| Memory `.index`/`.graph`, build output, dependencies, Eve caches, userbot venv | No | They are derived and rebuilt from code or the vault |

The vault is only memory. A vault-only recovery honestly restores Markdown memory and attachments,
but it does not restore tasks, reminders, OAuth, Telegram polling position, userbot authorization, or
Workflow sessions.

## Create and verify a backup

Run as the same dedicated user that owns Iva:

```bash
iva backup
# or choose a directory outside the code repository:
iva backup /secure/off-host/mount/iva-backup
```

The default destination is a new timestamped directory under `~/iva-backups/`. Iva refuses an
existing destination or any destination inside the code repository. It briefly stops all agent,
Telegram, userbot, reminder, memory, and timer writers; fixes known secret-file permissions; copies
the state; creates a profile-specific Workflow snapshot; records SHA-256 and size for every payload
file; verifies the finished artifact; then restores exactly the units that were active.

The backup is a directory, not an opaque archive. Its root and subdirectories are `0700`; every file,
including `backup.json`, is `0600`. `backup.json` contains commit/version/profile, checksums, sizes,
and exclusions, but no credentials, database URL, private source path, prompts, or memory contents.
Copy the whole directory to encrypted/off-host storage. Filesystem permissions do not encrypt the
backup from root or from the storage provider.

For PostgreSQL, `psql`, `pg_dump`, and `pg_restore` must be installed. The `pg_dump` major version
must be at least the server major version. Connection credentials are supplied through PostgreSQL
environment variables rather than command arguments. An incompatible client blocks backup before a
dump is accepted.

Iva never deletes old portable backups. Keep at least two verified generations in different failure
domains and delete older copies according to your own retention policy. The separate nightly vault
Git push remains useful, but it is not a replacement for a full portable backup.

## Restore on a clean host

Install the same or a compatible Iva version first, but do not start polling on the new host. Copy the
entire portable directory there, then run:

```bash
iva restore /secure/iva-backup --yes
```

Restore verifies every checksum and private mode before changing state, stops every managed writer,
restores configuration, data, vault, and the active Workflow profile in manifest order, rebuilds the
production output, and checks the capability manifest. `--yes` is required for non-interactive use;
without it the CLI asks for confirmation.

Managed services deliberately remain stopped after restore. This prevents the old and new hosts from
polling the same Telegram bot simultaneously. Stop Iva on the old host, then on the new host run:

```bash
iva start
iva doctor
```

The userbot session is restored when present but remains opt-in. Enable it only after the old proxy is
stopped:

```bash
iva userbot setup
```

For a PostgreSQL restore, the target database must exist and be reachable using the restored Workflow
configuration. Restore uses `pg_restore --clean --if-exists --no-owner --no-privileges`; never point it
at an unrelated or shared database. A failed restore leaves managed services stopped for diagnosis.

## Proven restore contract

Every pull request runs a local clean-host drill that verifies inventory checksums and modes, restores
tasks/reminders, recalls a synthetic memory fact, restores local Workflow state and opt-in session
files, proves derived indexes are absent, and confirms that the code capability manifest did not
change. The PostgreSQL replica creates a real custom dump, restores it into a separate disposable
database, and compares durable Workflow runs. Neither drill can access production data or secrets.
