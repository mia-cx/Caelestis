import type { StatusDelta, TemplateStatus } from '@caelestis/shared'
import type { ServerConnection } from './settings.js'

const sameStatus = (left: TemplateStatus | undefined, right: TemplateStatus): boolean =>
  left !== undefined &&
  left.templateId === right.templateId &&
  left.correct === right.correct &&
  left.wrong === right.wrong &&
  left.blank === right.blank &&
  left.total === right.total &&
  left.observedAt === right.observedAt &&
  (left.colours === undefined
    ? right.colours === undefined
    : right.colours !== undefined &&
      left.colours.length === right.colours.length &&
      left.colours.every((colour, index) => {
        const other = right.colours?.[index]
        return (
          other !== undefined &&
          colour.index === other.index &&
          colour.correct === other.correct &&
          colour.wrong === other.wrong &&
          colour.blank === other.blank &&
          colour.total === other.total
        )
      }))

interface ServerStatuses {
  /** The connection the values were read through; a reconnect starts from a fresh snapshot. */
  server: ServerConnection
  readonly values: Map<string, TemplateStatus>
}

/** One browser client's materialized status values per server, independent of transport. */
export class ClientStatusProjection {
  readonly #servers = new Map<string, ServerStatuses>()

  entry(
    serverUrl: string,
    templateId: string,
  ): { readonly server: ServerConnection; readonly value: TemplateStatus } | undefined {
    const held = this.#servers.get(serverUrl)
    const value = held?.values.get(templateId)
    return held === undefined || value === undefined ? undefined : { server: held.server, value }
  }

  /** Whether `next` would change what is held for this server. */
  differs(serverUrl: string, next: readonly TemplateStatus[]): boolean {
    const held = this.#servers.get(serverUrl)?.values ?? new Map<string, TemplateStatus>()
    return (
      held.size !== next.length ||
      next.some((status) => !sameStatus(held.get(status.templateId), status))
    )
  }

  replace(server: ServerConnection, next: readonly TemplateStatus[]): void {
    this.#servers.set(server.url, {
      server,
      values: new Map(next.map((status) => [status.templateId, status])),
    })
  }

  /** Apply replacements and removals; whether anything changed. */
  applyDelta(server: ServerConnection, delta: StatusDelta): boolean {
    let held = this.#servers.get(server.url)
    if (held === undefined) {
      held = { server, values: new Map() }
      this.#servers.set(server.url, held)
    }
    held.server = server
    let changed = false
    for (const status of delta.templates) {
      if (sameStatus(held.values.get(status.templateId), status)) continue
      held.values.set(status.templateId, status)
      changed = true
    }
    for (const templateId of delta.removedTemplateIds)
      changed = held.values.delete(templateId) || changed
    return changed
  }

  forget(serverUrl: string): void {
    this.#servers.delete(serverUrl)
  }
}
