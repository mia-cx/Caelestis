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
  /** Retire expired identities before reads, inserts, or renewal. */
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
  /** Read an owned identity, including withdrawn replicas; deleted identities return null. */
  readRegion(id: string): Promise<RegionClaim | null>
  /** A terminal identity cannot be reused, even by an old client or an administrator. */
  isRegionDeleted(id: string): Promise<boolean>
  /** Returns false when the identity already exists, including withdrawn or deleted records. */
  createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean>
  /** Update content and template hint; adopt unowned legacy claims. Null means missing or forbidden. */
  updateRegion(
    id: string,
    document: RegionDocument,
    label: string,
    templateId: string | null,
    writer: RegionWriter,
  ): Promise<RegionClaim | null>
  /** Retire an owned identity; withdrawal hides a replica but permits its owner to restore it. */
  deleteRegion(id: string, writer: RegionWriter, withdraw?: boolean): Promise<boolean>
}
