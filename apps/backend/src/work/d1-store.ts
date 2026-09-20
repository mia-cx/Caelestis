import { RelationalWorkStore } from './relational-store.js'

/** Cloudflare binding adapter for the shared work store. */
export class D1WorkStore extends RelationalWorkStore {
  // biome-ignore lint/complexity/noUselessConstructor: this adapter narrows SqlConnection to the Cloudflare D1 binding.
  constructor(database: D1Database) {
    super(database)
  }
}
