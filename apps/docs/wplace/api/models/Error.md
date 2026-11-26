---
title: Error
description: The JSON error body Wplace returns with most 4xx responses.
model:
  name: Error
  schema:
    type: object
    properties:
      error:
        type: string
        example: Unauthorized
      status:
        type: integer
        example: 401
    required:
      - error
      - status
---

Most API errors carry this body. `error` is the HTTP reason phrase or a short machine-readable code, such as `invalid_name`.

Used by: [[Get-pixel]], [[Get-random-tile]], [[Get-overlay-participants]], [[Paint-pixels]], [[Get-player-leaderboard]], [[Get-alliance-leaderboard]], [[Get-alliance-member-leaderboard]], [[Get-headquarters-leaderboard]], [[Get-alliance]], [[Get-alliance-headquarters]], [[Join-open-alliance]], [[Create-alliance]], [[Rename-alliance]], [[Update-alliance-description]], [[Update-alliance-settings]], [[Set-alliance-discord-invite]], [[Get-alliance-activity]], [[Kick-alliance-member]], [[Ban-from-alliance]], [[Unban-from-alliance]], [[Promote-alliance-admin]], [[Demote-alliance-admin]], [[Set-alliance-member-role]], [[Get-alliance-role-permissions]], [[Set-alliance-role-permissions]], [[Transfer-alliance-leadership]], [[List-alliance-invites]], [[Create-alliance-invite]], [[Revoke-alliance-invite]], [[List-join-requests]], [[Review-join-request]], [[Donate-to-alliance]], [[Buy-alliance-item]], [[Create-alliance-template]], [[Replace-alliance-template]], [[Update-alliance-template]], [[Place-alliance-template]], [[Delete-alliance-template]], [[Create-alliance-asset-draft]], [[Paint-alliance-asset]], [[Delete-alliance-asset-version]], [[Add-alliance-asset-editor]], [[Set-headquarters-location]], [[Unlock-headquarters]], [[Expand-headquarters]], [[Paint-headquarters]], [[Create-headquarters-timeout]], [[Revoke-headquarters-timeout]], [[Get-me]], [[Update-me]], [[Delete-me]], [[Resolve-account-conflict]], [[Report-player]], [[Submit-ban-appeal]].
