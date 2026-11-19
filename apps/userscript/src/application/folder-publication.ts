import { mapLimit } from '../concurrency.js'
import type { ServerTemplate } from '../server-manifest.js'

const PATCH_CONCURRENCY = 4

interface FolderPublicationFailure {
  readonly template: ServerTemplate
  readonly message: string
}

interface FolderPublicationResult {
  /** Templates that actually needed a change. */
  readonly requested: number
  readonly succeeded: number
  readonly failures: readonly FolderPublicationFailure[]
}

type PatchResult =
  | { readonly ok: true }
  /** `stop` (a refused credential, a replaced connection) ends the whole batch. */
  | { readonly ok: false; readonly message: string; readonly stop?: true }

/** Apply one publication state without opening an unbounded burst of template PATCH requests. */
export const setFolderTemplatesPublished = async (
  templates: readonly ServerTemplate[],
  published: boolean,
  patch: (template: ServerTemplate) => Promise<PatchResult>,
): Promise<FolderPublicationResult> => {
  const wanted = templates.filter((template) => template.published !== published)
  if (wanted.length === 0) return { requested: 0, succeeded: 0, failures: [] }

  const results = await mapLimit(
    wanted,
    PATCH_CONCURRENCY,
    patch,
    (result) => !result.ok && result.stop === true,
  )
  const stopped = results.find((result) => result?.ok === false && result.stop === true)
  const failures: FolderPublicationFailure[] = []
  wanted.forEach((template, index) => {
    const result = results[index] ?? stopped
    if (result?.ok === false) failures.push({ template, message: result.message })
  })
  return {
    requested: wanted.length,
    succeeded: wanted.length - failures.length,
    failures,
  }
}
