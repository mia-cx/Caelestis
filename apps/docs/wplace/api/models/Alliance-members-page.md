---
title: Alliance members page
description: One page of an alliance's public member list, 50 members at a time.
model:
  name: Alliance-members-page
  schema:
    type: object
    properties:
      data:
        type: array
        items:
          $ref: Alliance-member
      filteredTotal:
        type: integer
        example: 120
      total:
        type: integer
        example: 120
      hasNext:
        type: boolean
        example: true
---

Returned by [[List-alliance-members]].
