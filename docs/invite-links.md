# Invite links

A Caelestis invite link connects the userscript to a backend in one click, without typing the
server address and access token into Settings. It is a stopgap until accounts arrive, so it is
deliberately static: the link itself carries everything needed, and the server keeps no invite
records.

## Format

```text
https://wplace.live/#<server-base64url>.<token-base64url>
```

Both parts are the unpadded base64url encoding (RFC 4648 §5) of the UTF-8 bytes of the canonical
server URL and the provider access token.

The link contains the access token, so share it exactly the way you would share the token itself —
anyone who opens it connects to your server with it.

## Example

For server `https://caelestis.example` and token `example-token` the invite is:

```text
https://wplace.live/#aHR0cHM6Ly9jYWVsZXN0aXMuZXhhbXBsZQ.ZXhhbXBsZS10b2tlbg
```

Build one for your own server in a shell:

```sh
node -e 'const e=(s)=>Buffer.from(s,"utf8").toString("base64url"); console.log(`https://wplace.live/#${e("https://caelestis.example")}.${e("example-token")}`)'
```

## What happens on open

Opening the link on Wplace makes the userscript probe the server with the token, add it to the
server list, and report the outcome as a toast — success, an invalid link, a rejected token, an
unreachable server, or the connection limit. A server you are already connected to is never
duplicated; a working invite token replaces the stored one. Either way the invite is removed from
the address bar, since it should be treated as consumed once read.
