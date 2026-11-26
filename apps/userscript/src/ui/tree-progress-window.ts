import { DAY_SECONDS, parseProgressWindow } from '@caelestis/shared'
import { closeOperation, showOperation, updateOperation } from '../application/tree-presentation.js'
import { refreshEditedSurface } from '../application/tree-server.js'
import { patchNodeProgressWindow, patchTemplate } from '../server-api.js'
import { hasServerAdminToken, isCurrentServerConnection } from '../server-connections.js'
import { manifestRows } from '../server-manifests.js'
import type { TreeTarget } from './tree-context.js'
import { templateStateOf } from './tree-server-template.js'

const dateInput = (at: number | null | undefined): string =>
  at == null ? '' : new Date(at * 1_000).toISOString().slice(0, 10)

const dateSeconds = (date: string, offset = 0): number | null =>
  date === '' ? null : Date.parse(`${date}T00:00:00Z`) / 1_000 + offset

export const editProgressWindow = (target: TreeTarget, rerender: () => void): void => {
  const { server, nodeId, templateId, surface } = target
  if (server === null || (nodeId === null && templateId === undefined)) return
  if (!hasServerAdminToken(server) || !isCurrentServerConnection(server)) return
  const existing =
    templateId === undefined
      ? manifestRows(server, surface)?.nodes.find((node) => node.id === nodeId)
      : templateStateOf(target)
  if (existing == null) return
  const window = existing.progressWindow
  const note =
    'Dates are UTC and include the entire end date. Leave either blank to use the folder range when available.'
  const operation = showOperation(
    {
      label: `Progress dates for “${target.name}”`,
      note,
      confirmLabel: 'Save',
      progressDates: {
        start: dateInput(window?.start),
        end: dateInput(window?.end == null ? null : window.end - DAY_SECONDS),
      },
    },
    rerender,
    {
      onConfirm: (_value, dates) => {
        if (dates === undefined) return
        const progressWindow = parseProgressWindow({
          start: dateSeconds(dates.start),
          end: dateSeconds(dates.end, DAY_SECONDS),
        })
        if (progressWindow === null) {
          updateOperation(operation, {
            note: 'Use valid dates with the start on or before the end.',
          })
          return
        }
        if (!isCurrentServerConnection(server) || !hasServerAdminToken(server)) {
          updateOperation(operation, {
            note: 'Server connection changed. Close and reopen progress dates.',
          })
          return
        }
        updateOperation(operation, { pending: true, cancellable: false, note })
        const save =
          templateId === undefined && nodeId !== null
            ? patchNodeProgressWindow(server, nodeId, progressWindow)
            : templateId === undefined
              ? null
              : patchTemplate(server, templateId, { progressWindow })
        void save?.then(async (result) => {
          if (!result.ok) {
            updateOperation(operation, { pending: false, cancellable: true, note: result.message })
            return
          }
          closeOperation(operation)
          await refreshEditedSurface(server, surface, rerender)
        })
      },
    },
  )
}
