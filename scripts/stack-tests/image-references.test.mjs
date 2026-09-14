import assert from 'node:assert/strict'
import test from 'node:test'
import { removeImageReferences } from './image-references.mjs'

test('delayed cleanup preserves retagged images and tolerates already removed references', () => {
  const images = new Map([
    ['test/backend', 'sha256:replacement'],
    ['test/frontend', 'sha256:owned'],
  ])
  const removed = []
  const ctr = (_command, operation, reference) => {
    if (operation === 'list')
      return [
        'REF TYPE DIGEST',
        ...[...images].map(([ref, digest]) => `${ref} manifest ${digest}`),
      ].join('\n')
    assert.equal(operation, 'remove')
    removed.push(reference)
    images.delete(reference)
    return ''
  }
  const targets = {
    'test/backend': 'sha256:original',
    'test/frontend': 'sha256:owned',
    'test/missing': 'sha256:gone',
  }
  assert.deepEqual(removeImageReferences(ctr, targets), ['test/backend'])
  assert.deepEqual(removed, ['test/frontend'])
  assert.equal(images.get('test/backend'), 'sha256:replacement')
  assert.deepEqual(removeImageReferences(ctr, targets), ['test/backend'])
  assert.deepEqual(removed, ['test/frontend'])
})
