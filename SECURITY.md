# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/gaius-codius/ostrakon/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it and what it affects. This is a
one-person project, so expect a reply within about a week.

## What to know when running the hub

The hub (`server/hub.ts`) holds your notes and accepts writes, so treat it like any small service on your network:

- It **binds to `127.0.0.1` only**. Reach it from other devices through `tailscale serve` (see `docs/phone.md`), never by binding it to a public interface or using Tailscale Funnel.
- Every `/api` call needs the bearer token (`HUB_TOKEN`). Generate a long random one (`openssl rand -hex 24`), keep it in a file only you can read (the systemd unit reads `~/.config/ostrakon-hub/env`), and rotate it if it leaks.
- The phone's Home Screen app carries the token in its start URL (`?token=…`) because iOS gives it separate storage. Anyone who sees that URL has the token.
- `HUB_LOGIN` (trusting the `Tailscale-User-Login` header) is off unless you set it. Set it only where every local user is trusted, because any local process can send that header to `127.0.0.1`.
- Notes are stored unencrypted in SQLite and as Markdown files. Don't jot secrets.

## Scope

Ostrakon is a Claude Code mod and runs with your user's permissions. Its data lives in the notes folder, the mirror folder if you set one, the cache at `~/.cache/ostrakon`, and the hub you configure.
