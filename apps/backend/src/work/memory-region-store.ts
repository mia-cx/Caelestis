import {
  MAX_PRESENCE_REGIONS,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  regionDocumentBounds,
  sameTemplateSurface,
  type TemplateSurface,
} from '@caelestis/shared'
import type { RegionStore, RegionWriter } from './region-store.js'

/** In-memory equivalent of D1's bounded region records. */
export class MemoryRegionStore implements RegionStore {
  private readonly records = new Map<string, RegionClaim>()
  private readonly owners = new Map<string, string | null>()

  private canWrite(region: RegionClaim, writer: RegionWriter): boolean {
    const owner = this.owners.get(region.id)
    return (
      writer.admin ||
      (region.claimant.wplaceUserId === writer.actorId &&
        (owner == null || owner === writer.tokenHash))
    )
  }

  async expireRegions(now: number): Promise<void> {
    for (const [id, region] of this.records) {
      if (region.expiresAt === undefined || region.expiresAt > now) continue
      this.records.delete(id)
      this.owners.delete(id)
    }
  }

  async renewRegions(tokenHash: string, actorId: number, now: number): Promise<void> {
    await this.expireRegions(now)
    for (const [id, region] of this.records) {
      if (this.owners.get(id) !== tokenHash || region.claimant.wplaceUserId !== actorId) continue
      this.records.set(id, { ...region, expiresAt: now + REGION_CLAIM_TTL_MS })
    }
  }

  async listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]> {
    await this.expireRegions(Date.now())
    return [...this.records.values()]
      .filter(
        (region) =>
          region.season === season &&
          sameTemplateSurface(region.surface, surface) &&
          (templateId === undefined || region.templateId === templateId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, MAX_PRESENCE_REGIONS)
  }
  async readRegion(id: string): Promise<RegionClaim | null> {
    await this.expireRegions(Date.now())
    return this.records.get(id) ?? null
  }
  async createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean> {
    await this.expireRegions(Date.now())
    const rect = regionDocumentBounds(region.document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    const count = [...this.records.values()].filter(
      (held) => held.season === region.season && sameTemplateSurface(held.surface, region.surface),
    ).length
    if (this.records.has(region.id) || count >= MAX_PRESENCE_REGIONS) return false
    this.records.set(
      region.id,
      structuredClone({
        ...region,
        expiresAt: region.expiresAt ?? Date.now() + REGION_CLAIM_TTL_MS,
        templateId: region.templateId ?? null,
        rect,
      }),
    )
    this.owners.set(region.id, tokenHash)
    return true
  }
  async updateRegion(
    id: string,
    document: RegionDocument,
    label: string,
    templateId: string | null,
    writer: RegionWriter,
  ): Promise<RegionClaim | null> {
    await this.expireRegions(Date.now())
    const current = this.records.get(id)
    if (current === undefined || !this.canWrite(current, writer)) return null
    const rect = regionDocumentBounds(document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    const region = structuredClone({ ...current, document, rect, label, templateId })
    this.records.set(id, region)
    if (this.owners.get(id) == null) this.owners.set(id, writer.tokenHash)
    return region
  }
  async deleteRegion(id: string, writer: RegionWriter): Promise<boolean> {
    const current = this.records.get(id)
    if (current === undefined || !this.canWrite(current, writer)) return false
    this.records.delete(id)
    this.owners.delete(id)
    return true
  }
}
