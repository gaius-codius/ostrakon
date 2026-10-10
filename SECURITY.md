# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/gaius-codius/ostrakon/security/advisories/new),
not in a public issue. Say what you found, how to reproduce it and what it affects. This is a
one-person project, so expect a reply within about a week.

## Running the hub safely

The hub (`server/hub.ts`) holds your notes and accepts changes to them, so treat it like any small service on your network:

- **It listens on `127.0.0.1` only.** Other devices reach it through something you put in front: `tailscale serve` (the easy option), or your own HTTPS proxy, tunnel or VPN (see [`docs/phone.md`](docs/phone.md#open-it)). Never bind it to a public interface. Keeping it private, on a tailnet or VPN, is safest. If you do put it on the public internet (Tailscale Funnel, Cloudflare Tunnel, a public proxy), the token is all that stands between anyone and your notes.
- **Every `/api` call needs the token** (`HUB_TOKEN`). Use a long random one: `install.sh --hub` makes one for you, or run `openssl rand -hex 24`. Keep it in a file only you can read (the systemd unit reads `~/.config/ostrakon-hub/env`), and replace it if it leaks.
- **The phone's Home Screen app keeps the token in its start address** (`?token=…`), because iOS gives the installed app its own storage. Anyone who sees that address has the token.
- **Pairing codes are short-lived.** The QR code from `ostrakon pair` carries a one-time code that works once and expires after 5 minutes; the phone trades it for the token. `ostrakon pair --token` prints a QR with the token itself in it: don't share a screenshot of that, and clear the terminal after scanning. Either way, the phone ends up holding the long-lived token, in its storage and, on iOS, in the Home Screen app's start address.
- **`HUB_LOGIN` is off unless you set it.** It lets a request through without the token when the `Tailscale-User-Login` header names that login. Set it only on a machine where you trust every local user, because any local program can send that header straight to `127.0.0.1`.
- **Notes aren't encrypted.** They're stored as plain SQLite and Markdown files. Don't jot secrets.

## Scope

Ostrakon is a Claude Code mod, and it runs with your user's permissions. Its data lives in the notes folder, the mirror folder if you set one, the cache at `~/.cache/ostrakon`, and the hub you point it at.
