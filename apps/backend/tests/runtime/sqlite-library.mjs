// Bun uses Apple's SQLite on macOS. Allow an explicit library for local parity checks;
// Linux CI exercises Bun's bundled SQLite with this option unset.
if (process.versions.bun && process.env.CAELESTIS_TEST_SQLITE_LIBRARY) {
  const { Database } = await import('bun:sqlite')
  Database.setCustomSQLite(process.env.CAELESTIS_TEST_SQLITE_LIBRARY)
}
