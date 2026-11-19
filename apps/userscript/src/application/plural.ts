/** A count with its noun, `1 template` or `2 templates`, for nouns that take an s. */
export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`
