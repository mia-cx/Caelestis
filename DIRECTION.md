# Caelestis

Caelestis helps Wplace painters create, host, place, and maintain templates together.
The backend owns template status, telemetry, and alarms. The dashboard and installed clients consume that shared state.

## Release direction

The v1 implementation is complete, including the Ditherette-powered template studio.
The next release is 1.0.0 for the userscript, frontend, and backend.
The browser extension shares the userscript's source and version.
The docs site deploys with the release and stays unversioned.

Mia merges the current release pull request herself. Its merge closes the v1 map.
The release workflow publishes the installers, deploys the server apps, and posts the configured announcements.

## Next scope

The v1.x milestone holds extension store publication, localisation, reported client bugs, tile monitoring, and peer sharding.
The v2 milestone holds personal authentication, campaign coordination, and server federation.

GitHub maps and milestones are the delivery record.
Use the v1 map for settled decisions and the extension map for store-release requirements.

- [v1 map](https://github.com/mia-cx/Caelestis/issues/1)
- [Extension map](https://github.com/mia-cx/Caelestis/issues/685)
- [Milestones](https://github.com/mia-cx/Caelestis/milestones)

## Boundaries

Ditherette remains a separate project consumed through its published npm/WASM interface.
Canvas observations determine progress. Paint reports provide contribution evidence.
Wplace session cookies, CAPTCHA tokens, and raw request bodies stay outside Caelestis contracts.
