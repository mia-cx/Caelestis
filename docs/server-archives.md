# Server archives

A server archive is one file that holds a whole Caelestis server. Restore it on any deployment
target, database, or object store. The archive stays usable after the old provider is gone.

## Move a server

1. Provision the destination: a new deployment with an empty database and an empty bucket or
   object directory. Configure its secrets as for any new server.
2. Build the archive client from this repository with `pnpm --filter @caelestis/backend build`.
   The portable image already contains it at the same path.
3. Export the source with the source's admin token:

   ```sh
   ADMIN_TOKEN=... node apps/backend/dist/archive/cli.js export https://old.example.com/backend/v1 server.ndjson
   ```

4. Restore into the destination with the destination's admin token:

   ```sh
   ADMIN_TOKEN=... node apps/backend/dist/archive/cli.js import https://new.example.com/backend/v1 server.ndjson
   ```

5. Point DNS or clients at the destination.

The source stays frozen after the export, so nothing it accepts later can miss the move. For a
backup instead of a move, run the client's `finish-export <source-url>` to resume its writes.
`status <url>` shows the operation in progress.

The client streams the file line by line. Memory stays bounded by one page, whatever the size of
the server.

## Directions

Every direction uses the same archive. The API URL is the server's API root, such as
`https://example.com/backend/v1`.

| From | To | Tested in |
| --- | --- | --- |
| Cloudflare (D1, R2, Durable Objects) | Node or Bun with SQLite and a filesystem | `tests/worker/archive.test.ts` |
| Node with SQLite and a filesystem | a new Cloudflare deployment | `tests/worker/archive.test.ts` |
| Node with SQLite and a filesystem | Node with SQLite and a filesystem | `tests/archive.test.ts` |
| SQLite and a filesystem | PostgreSQL or MariaDB with S3, and back | `tests/integration/archive.test.ts` |

Cloudflare to Cloudflare and PostgreSQL to MariaDB work the same way: the archive holds no
provider identifiers, so any exporter pairs with any importer.

## What an archive holds

- Every row of every server table: settings, credentials and revocations, folders, tags,
  templates and versions with their sources and recipes, work items and activity, telemetry,
  attribution, contributions, retained tile history, mirrored tiles, alarms and deadlines, live
  revisions, and deduplication records.
- The telemetry coordinator's state: pending counters, flush batches, retained counters, counter
  idempotency keys, and its statistics.
- Every in-progress Eralyon import with its progress. A running import wakes up on the
  destination after activation.
- Every object under the server's prefixes, social previews included, with content type and
  custom metadata. Each object carries its SHA-256.

An archive leaves out:

- Deployment configuration and secrets: `ADMIN_TOKEN`, the stored frontend read token,
  database, S3, and R2 credentials, `SERVER_ID`, `SERVER_NAME`, and `SEASON`. Configure them on
  the destination before you restore.
- The tile garbage collector's listing cursor. It belongs to one object store, so the restored
  server starts its scan from the beginning.
- Caches and sessions that rebuild themselves: manifest caches, presence rooms, open sockets,
  and scheduled wakeups that the restored data recomputes.

## Consistency

`export` closes a gate on the server. While it is closed:

- Every route except `/health`, `/server`, and `/admin/archive` answers 503 with `Retry-After: 60`.
- Every database write fails, whether it comes from HTTP, a live socket, an alarm, or a scheduled
  job. Each write checks the gate inside its own transaction, so it either commits before the
  gate closes or fails.
- The telemetry coordinator refuses new counter records and waits for the ones it already
  admitted. Flushes and pruning wait too.
- An Eralyon import step that started earlier finishes before its state is read. Later steps
  only re-arm their wakeup.

A portable server also waits for every write its process already admitted. Then the export reads
a dataset that no longer changes. Caches that nothing references, such as derived artifacts and
social previews, can still appear; an archive with or without them restores the same server.

An event the source accepted before the gate is in the archive with its deduplication key, so a
client that replays it to the destination gets `duplicate`. A paint whose counters were refused
fails, so its client retries it. The destination applies it once, re-recording the counters from
the stored classification.

A restore also waits `ARCHIVE_SETTLE_SECONDS`, 2 by default, before it accepts records. That lets
other Worker isolates' one-second gate caches expire, so no request reads a partial dataset.

## Restore policy

**New servers only.** A restore refuses a destination with rows in any server table, objects
under any server prefix, or telemetry state. The error names each location. It never merges or
overwrites. Two kinds of rows are allowed: the destination's own credentials, and rows the
migrations seed. The check runs after the gate closes, so nothing can land between the check and
the restore.

**Credentials.** Token hashes, scopes, labels, and revocations arrive unchanged. A revoked token
stays revoked. The destination keeps its own tokens beside them. When both hold the same token, for
example a shared `CAELESTIS_READ_TOKEN`, the destination's row stays as it is, scope included.
An archive holds hashes only, never a usable token.

**Identity.** The destination keeps the identity it is configured with. To keep clients treating it
as the same server, set its `SERVER_ID` to the source's. The import prints that as
`sourceServerId`.

**Revisions and reconnects.** Live revisions continue from the source's. During a restore, clients
get 503 and retry. After activation they reconnect with their last revision and receive what
changed.

## Verification

Each check runs before anything is served:

1. The header names a format version and every table and column. A newer version, an unknown
   column, or a missing required column fails with the fix to apply.
2. The destination object store must return the bytes, content type, and metadata of a probe
   object.
3. Each object must match its SHA-256 when it arrives.
4. Each line extends a SHA-256 chain. The final `end` record states the chain and the count of every
   record kind, so an edited, reordered, or truncated archive fails.
5. The database enforces every foreign key as rows arrive.

Only `import/activate`, after a verified `end` record, opens the server. Once a discard has
started, activation is refused; only finishing the discard reopens the server.

## Recovery and rollback

- **Interrupted export:** run the same command again. It resumes from `server.ndjson.cursor`.
- **Interrupted import:** run the same command again. It resumes from the record the server has.
- **Rejected archive:** run the client's `discard <destination-url>`. It removes the restored data
  step by step, keeps the destination's own credentials, and reopens the empty server.
- **Rolling back a move:** the source still holds its data, frozen. Run `finish-export` on it and
  point clients back.

## Operation lifecycle

The `archive_operation` row is the operation's only durable record. While it exists, the server
is held. Its state names a phase:

| Kind | Phases |
| --- | --- |
| Export | `freezing` → `frozen` → `releasing` → row deleted |
| Restore | `preparing` → `ready` → `releasing` → row deleted |
| Restore, refused or cancelled before any record | `preparing` → `releasing` → row deleted |
| Restore, discarded | `ready` → `discarding` → `releasing` → row deleted |

| Transition | Durable write | Work in the phase it enters |
| --- | --- | --- |
| start export | insert row, `freezing` | close the process gate, drain writes, freeze counters |
| freeze done | `freezing` → `frozen` | none; pages read the frozen data |
| begin restore | insert row, `preparing` | close and drain, freeze counters, check emptiness and credentials, probe objects |
| preparation done | `preparing` → `ready` | none; records arrive |
| append records | position and state advance with the rows, in one batch | none |
| discard starts | `ready` → `discarding` | one bounded deletion per call, progress saved each time |
| finish, activate, cancel, or discard done | → `releasing` | close the counter operation, delete the row, thaw counters, reopen the process gate |

Concurrency is closed in two layers, because a restore and its discard write to stores that
cannot share one transaction:

1. **One request at a time.** Every lifecycle route that writes first takes the `archive_lease`
   row with one compare-and-set. A second request gets `409`, saying another archive request is
   running; the client waits and retries. The lease carries a fence that bumps on every
   take-over and a 120-second TTL, so a crashed holder stalls work only until the lease expires.
   Status reads stay lock-free. Near its deadline, expiry minus a safety margin, a call stops
   before the next external write or delete, saves progress, and returns the way chunked calls
   always could.
2. **Fences stop a stale caller.** If a stalled request loses its lease to a take-over, its next
   SQL batch fails anyway: every batch an archive call writes leads with a fence that commits
   only while the operation row still carries the expected state and the lease still carries the
   call's fence. In the counter store, each operation has a state that only moves forward:
   importing, cleaning, closed. Imports and cleanup must move it inside their own write
   transaction, so a late counter append or a stale discard is refused even after its caller's
   lease is gone. Discard records the template ids it must clean before deleting the rows that
   carried them, and its final pass checks that backfill state by id, checkpointed across calls
   so a large restore resumes where it stopped.

Then the operation row's own rules:

3. **Each transition is a compare-and-set on the whole prior row:** operation id, position, and
   state. A call that read a stale row changes nothing and gets 409. So activation can never open
   a restore whose discard started, and a cancelled preparation can never publish `ready`.
4. **Work inside a phase is idempotent, and whoever finds the phase may run it again.** A crash
   mid-phase leaves the row in that phase. The next call finishes it: `export` or an export page
   re-freezes, the restore header re-runs preparation, and any lifecycle call completes
   `releasing`. Cancelling `preparing` deletes nothing, because no record was accepted. A side
   effect that cannot join the compare-and-set, such as freezing counters, is checked against the
   row afterwards and undone if the row moved on. Each probe of the object store uses its own
   random key.
5. **Writes reopen last.** Releasing closes the operation's counter state, deletes the row,
   thaws the counter freeze, then reopens the process gate, so records stay refused while the
   operation still holds the server. A crash between the delete and the thaw leaves only a
   freeze that clears itself on the next record; a failure earlier leaves the row in `releasing`,
   still holding the server, and the next lifecycle call finishes it. Counter freezes and
   process gates are keyed by operation id, so a late release of an old operation cannot
   unfreeze a newer one.

A discard ends with a cheap extra pass over every location: SQL tables, counter tables,
recorded backfill ids, object prefixes. A write that outlived its own lease deadline and landed
after its step ran is found there and cleaned on the repeat pass.

The one residual risk: a process that stalls longer than the 120-second lease while an
object-store PUT or DELETE is already in flight can still land that one request after the lease
is taken over. The fence keeps its SQL, counter, and backfill writes out; an object write that
was already on the wire can remain, and a later discard's final pass removes it.

Admitted work drains before a freeze returns: relational writes in the process, and counter
records and flushes in the telemetry coordinator.

## Adapter requirements

Archives depend only on the portable storage contracts, so a new adapter such as PlanetScale or
UploadThing works without a format change once it meets these:

- **Database:** a `SqlConnection` with atomic batches, foreign keys, row-value comparisons for
  keyset paging, and upserts. MariaDB gets `ON CONFLICT` through its translation layer. Tested on
  D1, SQLite, PostgreSQL 17, and MariaDB 11.8.
- **Object store:** an `ObjectStorage` that keeps content type and custom metadata and lists keys
  in byte order with its own cursors. A restore probes this first. Tested on R2, S3 (RustFS and
  VersityGW), and the filesystem. S3 reports `application/octet-stream` for objects stored without
  a type; archives treat both as "no type".

## Format

Version 1 is newline-delimited JSON, one record per line:

| Kind | Holds |
| --- | --- |
| `header` | format, version, archive id, source server id, and the column list of every table |
| `row` | one table row, keyed by column name |
| `link` | a self or cyclic reference, applied once every row exists |
| `counter` | one telemetry coordinator row |
| `backfill` | one Eralyon import key |
| `object` | key, SHA-256, content type, metadata, and base64 bytes |
| `end` | the chain value and the count of each record kind |

## API

The client wraps these admin routes. Every response is JSON except export pages.

| Route | Does |
| --- | --- |
| `GET /admin/archive` | The operation in progress, if any |
| `POST /admin/archive/export` | Close the gate and wait for admitted writes |
| `GET /admin/archive/export?cursor=` | One NDJSON page; the `caelestis-archive-next` header holds the next cursor |
| `DELETE /admin/archive/export` | Reopen the source |
| `POST /admin/archive/import` | Send the header line; begins or resumes a restore |
| `POST /admin/archive/import/records?position=` | Send up to 500 lines starting at `position` |
| `POST /admin/archive/import/activate` | Open the restored server |
| `DELETE /admin/archive/import` | Discard one bounded step; repeat until `done` |
