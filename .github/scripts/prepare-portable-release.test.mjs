import assert from 'node:assert/strict'
import { it } from 'node:test'
import { portableImages, portableVersion } from './prepare-portable-release.mjs'

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

it('maps every image variant to Docker Hub and GHCR', () => {
  const images = portableImages('backend-1.2.3-frontend-4.5.6', 'mia-riezebos/Caelestis')
  assert.deepEqual(
    images.map(({ component, source, tag }) => ({ component, source, tag })),
    [
      {
        component: 'backend',
        source: 'backend',
        tag: 'backend-1.2.3-frontend-4.5.6',
      },
      {
        component: 'backend-node',
        source: 'backend',
        tag: 'backend-1.2.3-frontend-4.5.6-node',
      },
      {
        component: 'backend-bun',
        source: 'backend-bun',
        tag: 'backend-1.2.3-frontend-4.5.6-bun',
      },
      {
        component: 'frontend',
        source: 'frontend',
        tag: 'backend-1.2.3-frontend-4.5.6',
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
  assert.throws(() => portableImages('tag', 'missing-owner'))
})
