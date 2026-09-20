import {
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  regionDocumentBounds,
  sameTemplateSurface,
  type TemplateSurface,
} from '@caelestis/shared'
import type { RegionOwner, RegionStore, RegionWriter } from './region-store.js'

/** In-memory equivalent of the relational region records. */
export class MemoryRegionStore implements RegionStore {
  private readonly records = new Map<string, RegionClaim>()
  private readonly owners = new Map<string, string | null>()
  private readonly deleted = new Set<string>()
  private readonly withdrawn = new Set<string>()

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
      this.withdrawn.delete(id)
    }
  }

  async renewRegions(tokenHash: string, actorId: number, now: number): Promise<boolean> {
    await this.expireRegions(now)
    let changed = false
    for (const [id, region] of this.records) {
      if (
        this.withdrawn.has(id) ||
        this.owners.get(id) !== tokenHash ||
        region.claimant.wplaceUserId !== actorId
      )
        continue
      this.records.set(id, { ...region, expiresAt: now + REGION_CLAIM_TTL_MS })
      changed = true
    }
    return changed
  }

  async regionOwners(season: number, surface: TemplateSurface): Promise<readonly RegionOwner[]> {
    return [...this.records.values()]
      .filter(
        (region) =>
          !this.withdrawn.has(region.id) &&
          region.season === season &&
          sameTemplateSurface(region.surface, surface),
      )
      .flatMap(({ id, claimant }) => {
        const tokenHash = this.owners.get(id)
        return tokenHash == null ? [] : [{ id, tokenHash, actorId: claimant.wplaceUserId }]
      })
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
          !this.withdrawn.has(region.id) &&
          region.season === season &&
          sameTemplateSurface(region.surface, surface) &&
          (templateId === undefined || region.templateId === templateId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  async readRegion(id: string): Promise<RegionClaim | null> {
    await this.expireRegions(Date.now())
    return this.records.get(id) ?? null
  }
  async createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean> {
    await this.expireRegions(Date.now())
    const rect = regionDocumentBounds(region.document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    if (this.records.has(region.id) || this.deleted.has(region.id)) return false
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
  async isRegionDeleted(id: string): Promise<boolean> {
    return this.deleted.has(id)
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
    this.withdrawn.delete(id)
    if (this.owners.get(id) == null) this.owners.set(id, writer.tokenHash)
    return region
  }
  async deleteRegion(id: string, writer: RegionWriter, withdraw = false): Promise<boolean> {
    const current = this.records.get(id)
    if (current === undefined) return false
    if (
      withdraw
        ? !this.canWrite(current, writer)
        : !writer.admin && current.claimant.wplaceUserId !== writer.actorId
    )
      return false
    if (withdraw) this.withdrawn.add(id)
    else {
      this.records.delete(id)
      this.owners.delete(id)
      this.withdrawn.delete(id)
      this.deleted.add(id)
    }
    return true
  }
}
