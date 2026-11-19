/** Whether an archive operation holds the server; `archiveGate` in `fence.ts` implements it. */
export interface ArchiveStatus {
  /**
   * Whether a server archive export or import currently holds the server. The answer is cached for
   * at most a second unless `fresh` asks for a read. Writes never depend on the cache: each one
   * fails inside its own transaction while the gate is closed.
   */
  archiveOperationActive(options?: { readonly fresh?: boolean }): Promise<boolean>
}
