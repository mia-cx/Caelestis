#!/usr/bin/env bash
# Packs the built extension in apps/userscript/dist/extension into <output-dir>:
#
#   caelestis-extension.zip         the store package for Chrome, Edge and Firefox
#   caelestis-extension-source.zip  the source archive addons.mozilla.org rebuilds it from
#
# Run from the repository root after `pnpm --filter @caelestis/userscript... build` on a clean checkout.
# The source archive carries apps/userscript/build-revision.json, so a build from it without Git embeds
# the same commit and produces the same files.
set -euo pipefail

output="${1:?usage: package-extension.sh <output-dir>}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'The checkout has uncommitted changes, so the build would not match its source archive.' >&2
  exit 1
fi

revision="$(git rev-parse HEAD)"
version="$(node -p 'require("./apps/userscript/package.json").version')"
manifest_version="$(node -p 'require("./apps/userscript/dist/extension/manifest.json").version')"
if [ "$manifest_version" != "$version" ]; then
  echo "The built manifest says $manifest_version, but the userscript package is $version." >&2
  exit 1
fi

# Fixed timestamps and a sorted file list, so the same files always make the same zip.
(
  cd apps/userscript/dist/extension
  find . -exec touch -h -t 198001010000 {} +
  find . -type f | LC_ALL=C sort | zip -X -D -q "$output/caelestis-extension.zip" -@
)

node_version="$(node -p process.versions.node)"
pnpm_version="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
readme="# Build the Caelestis extension

This is the Caelestis source at commit $revision, which built caelestis-extension.zip v$version.
apps/userscript/build-revision.json records that commit for the build.

With Node.js $node_version and pnpm $pnpm_version, run from this folder:

    pnpm install --frozen-lockfile && pnpm --filter @caelestis/userscript... build

The extension is in apps/userscript/dist/extension/, with the same files as caelestis-extension.zip.
"

git archive --format=zip --output="$output/caelestis-extension-source.zip" \
  --add-virtual-file="apps/userscript/build-revision.json:{\"revision\":\"$revision\",\"dirty\":false}
" \
  --add-virtual-file="BUILD-EXTENSION.md:$readme" \
  HEAD
