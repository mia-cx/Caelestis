---
title: Anti-cheat
description: The requests behind Wplace's challenges, listed so mods recognise them.
order: 13
---

The requests the client sends while the player solves a challenge. They are listed so mod authors recognise them, not to automate them. [[Anti-cheat]] explains what Pawtect collects.

- [Device attestation](device/): Apple device checks that only the Wplace iOS app sends.

- [[Verify-challenge|Submit a challenge result]]: Submit a solved proof of work, captcha or phone code after a challenge.
- [[Create-captcha-session|Submit a captcha]]: Exchange a solved Turnstile or hCaptcha for a challenge session.
- [[Get-proof-of-work-challenge|Get a proof-of-work challenge]]: Get the hash puzzle for the lightest challenge tier.
- [[Get-phone-code-cooldown|Get phone code cooldown]]: Get how long before another phone verification code can be sent.
- [[Send-phone-code|Send a phone code]]: Send a verification code by SMS, Telegram or WhatsApp for the heaviest challenge.
- [[Verify-fingerprint|Submit a device check]]: Send a Fingerprint Pro sealed result after a `verification-required` refusal.
