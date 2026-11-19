import { sameTemplateSurface, type TemplateSurface } from '@caelestis/shared'
import { navigateAllianceArtboardTo } from '../alliance-navigation.js'
import { activeAllianceSurface } from '../alliance-surface.js'
import type { ServerTemplate } from '../server-manifest.js'
import { previewOriginFor, templateById } from '../templates/catalog.js'
import { centreOf, centreOfBounds, navigateTo } from '../templates/navigate.js'
import { showToast } from './notification-host.js'

/** Frame one manifest row even when its pixels have not reached the local catalog yet. */
export const goToServerTemplate = (
  bbox: ServerTemplate['bbox'],
  surface: TemplateSurface,
): void => {
  if (surface.kind !== 'world') {
    const active = activeAllianceSurface()
    if (active === null || !sameTemplateSurface(active.surface, surface)) return
    navigateAllianceArtboardTo(active, {
      x: (bbox.minX + bbox.maxX) / 2,
      y: (bbox.minY + bbox.maxY) / 2,
    })
    return
  }
  navigateTo(centreOfBounds(bbox))
}

/** Frame the current placement of one catalog template, including its live placement preview. */
export const goToLocalTemplate = (templateId: string): void => {
  const template = templateById(templateId)
  if (template === undefined) return
  const preview = previewOriginFor(templateId)
  const surface = template.surface
  if (surface.kind !== 'world') {
    const active = activeAllianceSurface()
    if (active === null || !sameTemplateSurface(active.surface, surface)) return
    navigateAllianceArtboardTo(active, {
      x: (preview?.x ?? template.originX) + template.width / 2,
      y: (preview?.y ?? template.originY) + template.height / 2,
    })
    return
  }
  if (preview !== null) {
    navigateTo(centreOf({ ...template, originX: preview.x, originY: preview.y }))
    return
  }
  if (template.source === 'image' && !template.everPlaced) {
    showToast(`“${template.name}” has not been placed yet.`, 'warning')
    return
  }
  navigateTo(centreOf(template))
}
