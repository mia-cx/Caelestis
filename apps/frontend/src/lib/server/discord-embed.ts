/**
 * Discord component embeds: a link preview layout Discord reads from
 * `script#discord:component-embed`, alongside the Open Graph tags it falls back to.
 *
 * The format is a draft (discord/discord-api-docs#8606), so everything here stays inside its
 * documented subset and limits. A payload that cannot fit is omitted, which leaves Open Graph.
 */

/** Discord drops a payload larger than this, counted in UTF-8 bytes after escaping. */
export const COMPONENT_EMBED_MAX_BYTES = 3000

const ACTION_ROW = 1
const BUTTON = 2
const TEXT_DISPLAY = 10
const MEDIA_GALLERY = 12
const CONTAINER = 17
/** Component embeds accept only link buttons. */
const LINK_STYLE = 5
/** Caelestis primary blue, #4093E4. */
const ACCENT_COLOR = 0x4093e4
const MAX_TITLE_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 300
const MAX_MEDIA_DESCRIPTION_LENGTH = 100

interface EmbedSource {
  title: string
  description: string
  url: string
  image: string
  imageAlt: string
}

const truncate = (text: string, max: number) => {
  const characters = [...text.replace(/\s+/g, ' ').trim()]
  return characters.length <= max
    ? characters.join('')
    : `${characters.slice(0, max - 1).join('')}…`
}

/** Operator text renders as plain text: no headings, links, mentions, or formatting. */
const plain = (text: string, max: number) =>
  truncate(text, max).replace(/[\\`*_~|<>#\-[\]()@]/g, '\\$&')

/**
 * Serialize the page's component embed for an inline `<script>`, or answer null when it would
 * break Discord's limits. `<` is escaped so no content can close the script element.
 */
export const discordComponentEmbed = (
  metadata: EmbedSource,
  discordInviteUrl?: string,
): string | null => {
  const invite =
    discordInviteUrl === undefined
      ? []
      : [{ type: BUTTON, style: LINK_STYLE, url: discordInviteUrl, label: 'Join Discord' }]
  const embed = {
    component: {
      type: CONTAINER,
      accent_color: ACCENT_COLOR,
      components: [
        {
          type: TEXT_DISPLAY,
          content: `## ${plain(metadata.title, MAX_TITLE_LENGTH)}\n${plain(metadata.description, MAX_DESCRIPTION_LENGTH)}`,
        },
        {
          type: MEDIA_GALLERY,
          items: [
            {
              media: { url: metadata.image },
              description: truncate(metadata.imageAlt, MAX_MEDIA_DESCRIPTION_LENGTH),
            },
          ],
        },
        {
          type: ACTION_ROW,
          components: [
            { type: BUTTON, style: LINK_STYLE, url: metadata.url, label: 'Open in Caelestis' },
            ...invite,
          ],
        },
      ],
    },
  }
  const json = JSON.stringify(embed).replaceAll('<', '\\u003c')
  return new TextEncoder().encode(json).length <= COMPONENT_EMBED_MAX_BYTES ? json : null
}
