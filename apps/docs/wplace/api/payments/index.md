---
title: Payments
description: Real-money checkouts through Stripe, FastSpring, Google Play and the App Store.
order: 9
---

Real-money purchases. Mods have no reason to call these; they are listed for completeness.

- [Mobile app payments](mobile/): Google Play and App Store purchase checks used by the Wplace mobile apps.

- [[Create-stripe-checkout|Start a card checkout]]: Start a Stripe checkout for a store product, optionally as a gift or with a coupon.
- [[Refresh-stripe-session|Refresh a card checkout]]: Ask the server to credit a finished Stripe checkout now.
- [[Get-stripe-session-status|Get card checkout status]]: Get whether a Stripe checkout is open, complete or expired.
- [[Create-fastspring-session|Start a FastSpring checkout]]: Start a FastSpring checkout for a store product.
- [[Refresh-fastspring-order|Refresh a FastSpring order]]: Ask the server to credit a finished FastSpring order now.
- [[Get-last-fastspring-order|Get my last FastSpring order]]: Get the signed-in player's most recent FastSpring order.
- [[Mark-fastspring-order-read|Dismiss a FastSpring order]]: Stop showing a finished FastSpring order to the player.
- [[Validate-promotion|Check a coupon]]: Check whether a coupon code applies to a product before checkout.
- [[List-payment-history|List my payments]]: Page through the signed-in player's purchases with real money.
