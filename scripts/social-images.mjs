import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { httpApi, refreshSocialImages } from '../packages/social/dist/index.js'
import { cachedMapTiles } from './osm-tiles.mjs'

/** Build locally by default. Publishing uploads changed GIFs with the Cloudflare CLI. */
export const buildSocialImages = async ({
  site,
  output,
  publish = false,
  local = false,
  bucket = 'caelestis-blobs',
  templateId,
}) => {
  await mkdir(output, { recursive: true })
  await refreshSocialImages({
    read: httpApi(new URL('/api/v1/', site)),
    readMapTile: cachedMapTiles(resolve(output, '.osm')),
    templateId,
    save: async (key, gif, template) => {
      const file = resolve(output, `${encodeURIComponent(template.id)}.gif`)
      await writeFile(file, gif)
      if (publish) {
        const previous = await fetch(
          new URL(`/social/template/${encodeURIComponent(template.id)}.gif`, site),
          { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(60_000) },
        )
        const etag = `"${createHash('md5').update(gif).digest('hex')}"`
        if (previous.ok && previous.headers.get('etag') === etag) {
          console.log(`${template.id}: unchanged`)
          return
        }
        execFileSync(
          'pnpm',
          [
            '--dir',
            'apps/frontend',
            'exec',
            'wrangler',
            'r2',
            'object',
            'put',
            `${bucket}/${key}`,
            local ? '--local' : '--remote',
            '--file',
            file,
            '--content-type',
            'image/gif',
          ],
          { stdio: 'inherit' },
        )
      }
      console.log(`${template.id}: ${gif.length} bytes${publish ? ', published' : ''}`)
    },
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      output: { type: 'string', default: '.scratch/social-images' },
      publish: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      bucket: { type: 'string', default: 'caelestis-blobs' },
      template: { type: 'string' },
    },
  })
  if (!values.site) throw new Error('Pass --site with the frontend URL to read')
  await buildSocialImages({ ...values, templateId: values.template })
}
