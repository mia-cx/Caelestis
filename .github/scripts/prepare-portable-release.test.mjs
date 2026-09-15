import assert from 'node:assert/strict'
import { it } from 'node:test'
import { portableImages, portableVersion, semanticImageTags } from './prepare-portable-release.mjs'

it('changes artifact versions when either app changes', () => {
  const initial = portableVersion('1.2.3', '4.5.6')
  assert.equal(initial.chartVersion, '1.2.3+frontend.4.5.6')
  assert.equal(initial.tag, 'server-backend-1.2.3-frontend-4.5.6')
  assert.equal(initial.nodeImageTag, `${initial.imageTag}-node`)
  assert.equal(initial.bunImageTag, `${initial.imageTag}-bun`)
  for (const next of [portableVersion('1.2.4', '4.5.6'), portableVersion('1.2.3', '4.5.7')]) {
    assert.notEqual(initial.imageTag, next.imageTag)
    assert.notEqual(initial.chartVersion, next.chartVersion)
    assert.notEqual(initial.nodeImageTag, next.nodeImageTag)
    assert.notEqual(initial.bunImageTag, next.bunImageTag)
  }
})

it('rejects prerelease, malformed, and shell-active version strings', () => {
  for (const invalid of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-beta.1', '1.0.0+build', '$(command)'])
    assert.throws(() => portableVersion(invalid, '1.0.0'))
})

it('builds immutable patch tags and moving semantic aliases', () => {
  assert.deepEqual(semanticImageTags('1.2.3'), {
    immutable: ['1.2.3'],
    moving: ['1.2', '1', 'latest'],
  })
  assert.deepEqual(semanticImageTags('1.2.3', '-bun'), {
    immutable: ['1.2.3-bun'],
    moving: ['1.2-bun', '1-bun', 'latest-bun'],
  })
})

it('maps Bun defaults and runtime choices to Docker Hub and GHCR', () => {
  const images = portableImages(portableVersion('1.2.3', '4.5.6'), 'mia-riezebos/Caelestis')
  assert.deepEqual(
    images.map(({ app, component, source, tag, aliases }) => ({
      app,
      component,
      source,
      tag,
      aliases,
    })),
    [
      {
        app: 'backend',
        component: 'backend',
        source: 'backend-bun',
        tag: 'backend-1.2.3-frontend-4.5.6',
        aliases: {
          immutable: ['1.2.3'],
          moving: ['1.2', '1', 'latest'],
        },
      },
      {
        app: 'backend',
        component: 'backend-node',
        source: 'backend',
        tag: 'backend-1.2.3-frontend-4.5.6-node',
        aliases: {
          immutable: ['1.2.3-node'],
          moving: ['1.2-node', '1-node', 'latest-node'],
        },
      },
      {
        app: 'backend',
        component: 'backend-bun',
        source: 'backend-bun',
        tag: 'backend-1.2.3-frontend-4.5.6-bun',
        aliases: {
          immutable: ['1.2.3-bun'],
          moving: ['1.2-bun', '1-bun', 'latest-bun'],
        },
      },
      {
        app: 'frontend',
        component: 'frontend',
        source: 'frontend',
        tag: 'backend-1.2.3-frontend-4.5.6',
        aliases: {
          immutable: ['4.5.6'],
          moving: ['4.5', '4', 'latest'],
        },
      },
    ],
  )
  assert.deepEqual(images[0].registries, {
    dockerhub: 'docker.io/miacx/caelestis-backend',
    ghcr: 'ghcr.io/mia-riezebos/caelestis-backend',
  })
  assert.deepEqual(images[3].registries, {
    dockerhub: 'docker.io/miacx/caelestis-frontend',
    ghcr: 'ghcr.io/mia-riezebos/caelestis-frontend',
  })
  assert.throws(() => portableImages(portableVersion('1.0.0', '1.0.0'), 'missing-owner'))
})
