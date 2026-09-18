import type { RegionClaim, RegionDocument, TemplateSurface } from '@caelestis/shared'

/** Credential and painter checks applied atomically with each mutation. */
export interface RegionWriter {
  readonly tokenHash: string
  readonly actorId: number
  readonly admin: boolean
}

/** Internal ownership keys. Never include credential hashes in a public claim snapshot. */
export interface RegionOwner {
  readonly id: string
  readonly tokenHash: string
  readonly actorId: number
}

/** Persisted claims; creation never overwrites an existing identity. */
export interface RegionStore {
  /** Remove expired rows before reads, inserts, or renewal. */
  expireRegions(now: number): Promise<void>
  /** Renew only unexpired claims owned by both this credential and painter. */
  renewRegions(tokenHash: string, actorId: number, now: number): Promise<boolean>
  /** Read all ownership keys once per drawing snapshot, regardless of subscriber count. */
  regionOwners(season: number, surface: TemplateSurface): Promise<readonly RegionOwner[]>
  listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]>
  readRegion(id: string): Promise<RegionClaim | null>
  /** Returns false when the ID exists or this surface has reached its claim limit. */
  createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean>
  /** Update content and template hint; adopt unowned legacy claims. Null means missing or forbidden. */
  updateRegion(
    id: string,
    document: RegionDocument,
    label: string,
    templateId: string | null,
    writer: RegionWriter,
  ): Promise<RegionClaim | null>
  /** Returns false when the claim is missing or the writer does not own it. */
  deleteRegion(id: string, writer: RegionWriter): Promise<boolean>
}
