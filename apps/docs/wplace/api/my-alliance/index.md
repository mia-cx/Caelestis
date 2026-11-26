---
title: My alliance
description: Endpoints for the signed-in player's own alliance, from settings to templates.
order: 5
---

Everything under `/alliance` acts on the signed-in player's own alliance. All of it needs the `j` cookie, and many actions need a role with the right permission; otherwise the server answers `403`.

- [Members and invites](members/): Manage alliance members, roles, bans, invite links and join requests.
- [Alliance economy](economy/): Alliance coins: the store, the ledger, donations and purchases.
- [Alliance templates](templates/): Shared image templates that alliance leaders place on the map for members.
- [Alliance pictures and banners](assets/): Draft, paint and publish an alliance's pixel-art picture and banner.
- [Alliance headquarters](headquarters/): The alliance's own headquarters canvas: unlock, expand, paint and moderate it.

- [[Get-own-alliance|Get my alliance]]: Get the signed-in player's own alliance, with their role in it.
- [[Create-alliance|Create an alliance]]: Create a new alliance with the signed-in player as leader.
- [[Leave-alliance|Leave my alliance]]: Leave the alliance the signed-in player belongs to.
- [[Rename-alliance|Rename my alliance]]: Rename the player's alliance, paid in alliance coins.
- [[Update-alliance-description|Update my alliance's description]]: Replace the Markdown description on the player's alliance profile.
- [[Update-alliance-settings|Update my alliance's settings]]: Change who can find and join the alliance, and who sees its headquarters.
- [[Set-alliance-discord-invite|Set my alliance's Discord invite]]: Set the Discord server invite shown on the alliance profile.
- [[Set-featured-awards|Pick featured awards]]: Choose which awards the alliance shows on its profile card.
- [[Get-alliance-activity|Get my alliance's activity]]: Page through the player's alliance activity log.
- [[Get-alliance-notification-preferences|Get alliance notification settings]]: Read which alliance events notify the signed-in player.
- [[Set-alliance-notification-preference|Set an alliance notification setting]]: Turn one category of alliance notifications on or off.
