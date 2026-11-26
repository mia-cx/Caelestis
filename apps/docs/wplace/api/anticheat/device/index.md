---
title: Device attestation
description: Apple device checks that only the Wplace iOS app sends.
---

None of this runs in a web browser.

- [[Get-device-attest-challenge|Get a device attestation challenge]]: Get the challenge the iOS app signs with Apple App Attest.
- [[Attest-device|Attest a device]]: Register the iOS app's App Attest key with the backend.
- [[Get-device-preauth-challenge|Get a pre-sign-in challenge]]: Get the challenge the iOS app signs before sign-in.
- [[Preauth-device|Pre-authorise a device]]: Exchange a signed challenge for the ticket the iOS app sends with sign-in.
- [[Check-device|Check a device token]]: Send an Apple DeviceCheck token from the iOS app.
