---
title: Notifications
description: In-app notifications, their live stream, and browser push.
order: 7
---

In-app notifications and browser push subscriptions. Requests in this group time out in the client after 15 seconds.

- [Push notifications](push/): Subscribe a browser to Wplace push notifications and change what they show.

- [[Get-notification-count|Count unread notifications]]: Get how many unread notifications the signed-in player has.
- [[List-notifications|List notifications]]: Page through the signed-in player's notifications.
- [[Get-notification-changes|Refresh notifications]]: Get the current state of notifications the client already shows.
- [[Mark-notifications-read|Mark notifications read]]: Mark some of the signed-in player's notifications as read.
- [[Mark-all-notifications-read|Mark all notifications read]]: Mark every notification of the signed-in player as read.
- [[Get-notification-preferences|Get notification settings]]: Read which kinds of notification the signed-in player gets.
- [[Set-notification-preference|Set a notification setting]]: Turn one kind of notification on or off.
- [[Notification-stream|Stream notifications]]: Receive new notifications as server-sent events while the page is open.
