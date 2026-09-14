import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTriage, fieldUpdates, labelIssue } from './pullfrog-project.mjs'

const context = {
  issue: { id: 'issue', url: 'https://github.com/example/repo/issues/1' },
  project: {
    id: 'project',
    url: 'https://github.com/users/example/projects/1',
    fields: [
      { id: 'status', name: 'Status', options: [{ id: 'ready', name: 'Ready' }] },
      { id: 'priority', name: 'Priority', options: [{ id: 'normal', name: 'Normal' }] },
      { id: 'effort', name: 'Effort', dataType: 'NUMBER' },
    ],
  },
  item: null,
}
const decision = { track: true, status: 'Ready', priority: 'Normal', effort: null, blockers: [] }

test('only auto-label issue payloads enable project writes', () => {
  const event = (payload) => ({ inputs: { prompt: JSON.stringify(payload) } })
  assert.equal(labelIssue({ inputs: { prompt: 'Review this code' } }), null)
  assert.equal(labelIssue({ inputs: { prompt: 'null' } }), null)
  assert.equal(labelIssue(event({ type: 'auto-label', event: { issue_number: 1 } })), null)
  assert.equal(
    labelIssue(event({ '~pullfrog': true, type: 'issue', event: { issue_number: 1 } })),
    null,
  )
  assert.equal(
    labelIssue(event({ '~pullfrog': true, type: 'auto-label', event: { issue_number: 1 } })),
    1,
  )
  assert.throws(() =>
    labelIssue(
      event({ '~pullfrog': true, type: 'auto-label', event: { issue_number: 1, is_pr: true } }),
    ),
  )
})

test('preserves maintainer values, including zero effort', () => {
  const populated = {
    ...context,
    item: {
      id: 'item',
      fieldValues: {
        nodes: [
          { field: { id: 'status' }, name: 'In Progress' },
          { field: { id: 'priority' }, name: 'Urgent' },
          { field: { id: 'effort' }, number: 0 },
        ],
      },
    },
  }
  assert.deepEqual(fieldUpdates(populated, { ...decision, effort: 5 }), [])
})

test('rejects invented options before adding a project item', async () => {
  let calls = 0
  await assert.rejects(
    applyTriage(context, { ...decision, status: 'Invented' }, async () => {
      calls++
    }),
    /Unknown Status/,
  )
  assert.equal(calls, 0)
})

test('adds membership, writes decisions and verifies actual returned fields', async () => {
  const calls = []
  const fields = []
  const api = async (query, variables) => {
    calls.push({ query, variables })
    if (query.includes('addProjectV2ItemById'))
      return { addProjectV2ItemById: { item: { id: 'item' } } }
    if (query.includes('updateProjectV2ItemFieldValue')) {
      fields.push({
        field: { id: variables.field },
        name: variables.field === 'status' ? 'Ready' : 'Normal',
      })
      return {}
    }
    return {
      node: {
        project: { id: 'project' },
        content: { id: 'issue' },
        fieldValues: { nodes: fields },
      },
    }
  }
  assert.match(await applyTriage(context, decision, api), /updated 2 empty fields/)
  assert.equal(calls.length, 6)
  assert.deepEqual(calls[0].variables, { project: 'project', issue: 'issue' })
  calls.length = 0
  await applyTriage(
    { ...context, item: { id: 'item', fieldValues: { nodes: fields } } },
    decision,
    api,
  )
  assert.equal(calls.length, 1, 'rerun only verifies existing membership and fields')
})

test('fails when GitHub does not retain the requested field value', async () => {
  const api = async (query) =>
    query.includes('updateProjectV2ItemFieldValue')
      ? {}
      : {
          node: {
            project: { id: 'project' },
            content: { id: 'issue' },
            fieldValues: { nodes: [] },
          },
        }
  await assert.rejects(
    applyTriage({ ...context, item: { id: 'item', fieldValues: { nodes: [] } } }, decision, api),
    /verification failed/,
  )
})

test('a skipped issue ignores unused field choices and causes no project mutations', async () => {
  let calls = 0
  await applyTriage(
    context,
    { ...decision, track: false, status: 'not a project option' },
    async () => {
      calls++
    },
  )
  assert.equal(calls, 0)
})

test('preserves a maintainer edit made after the initial context read', async () => {
  let writes = 0
  const api = async (query) => {
    if (query.includes('mutation')) writes++
    return {
      node: {
        project: { id: 'project' },
        content: { id: 'issue' },
        fieldValues: { nodes: [{ field: { id: 'status' }, name: 'In Progress' }] },
      },
    }
  }
  await applyTriage(
    { ...context, item: { id: 'item', fieldValues: { nodes: [] } } },
    { ...decision, priority: null },
    api,
  )
  assert.equal(writes, 0)
})
