import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Migration {
  readonly name: string
  readonly source: string
  readonly digest: string
}

/** A directory's `*.sql` migrations in apply order, each with the sha256 recorded when applied. */
export const readMigrations = (directory: string): Migration[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const source = readFileSync(join(directory, name), 'utf8')
      return { name, source, digest: createHash('sha256').update(source).digest('hex') }
    })

/** Applied migrations are immutable: refuse to start when one changed since it ran. */
export const assertUnchanged = (migration: Migration, appliedDigest: string): void => {
  if (appliedDigest !== migration.digest)
    throw new Error(`Migration changed after application: ${migration.name}`)
}
