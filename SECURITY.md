# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/gaius-codius/ostrakon/security/advisories/new),
not in a public issue. Say what you found, how to reproduce it and what it affects. This is a
one-person project, so expect a reply within about a week.

## Running the hub safely

The hub (`server/hub.ts`) holds your notes and accepts changes to them, so treat it like any small service on your network:

- **It listens on `127.0.0.1` only.** Other devices reach it through something you put in front: `tailscale serve` (the easy option), or your own HTTPS proxy, tunnel or VPN (see [`docs/phone.md`](docs/phone.md#open-it)). Never bind it to a public interface. Keeping it private, on a tailnet or VPN, is safest. If you do put it on the public internet (Tailscale Funnel, Cloudflare Tunnel, a public proxy), the token is all that stands between anyone and your notes. Leave `HUB_LOGIN` unset there (below), and turn off your proxy's logging of full addresses, since pairing puts the token in one (`?token=…`).
- **Every `/api` call needs the token** (`HUB_TOKEN`). Use a long random one: `install.sh --hub` makes one for you, or run `openssl rand -hex 24`. Keep it in a file only you can read (the systemd unit reads `~/.config/ostrakon-hub/env`), and replace it if it leaks.
- **The phone's Home Screen app keeps the token in its start address** (`?token=…`), because iOS gives the installed app its own storage. Anyone who sees that address has the token.
- **Pairing codes are short-lived.** The QR code from `ostrakon pair` carries a one-time code that works once and expires after 5 minutes; the phone trades it for the token. `ostrakon pair --token` prints a QR with the token itself in it: don't share a screenshot of that, and clear the terminal after scanning. Either way, the phone ends up holding the long-lived token, in its storage and, on iOS, in the Home Screen app's start address.
- **`HUB_LOGIN` is off unless you set it.** It lets a request through without the token when the `Tailscale-User-Login` header names that login. Use it only behind `tailscale serve` on your private tailnet, never behind Tailscale Funnel or any other proxy or tunnel: those can pass on a header the visitor made up, and then anyone can read your notes without the token. Even with `tailscale serve`, set it only on a machine where you trust every local user, because any local program can send that header straight to `127.0.0.1`.
- **The systemd unit sandboxes it.** Your home folder is read-only to the hub except its data folder, as is everything else outside your home, and it can't see `~/.ssh`, `~/.gnupg`, `~/.config/gh`, `~/.claude`, your session's sockets or Docker's. It still runs as you, so this limits a bug's reach rather than stopping it: what it can still read is in [What the hub can reach](docs/phone.md#what-the-hub-can-reach). `ostrakon doctor` says whether the running hub has these limits.
- **Filing notes as issues uses two tokens of the hub's own**, in its env file: a fine-grained GitHub token for the repos you pick (a classic one is refused) and a `claude setup-token` token. It never uses your own `gh` or Claude login. The tokens are in plain text in the env file, readable by the hub and any program running as you. A leaked GitHub token can change any issue in its repos until it expires, and read private repos' issues, so give it an expiry and as few repos as you need. Anyone with the hub token can file issues to those repos and use your Claude subscription, but not reach your account. These tokens are for filing from the phone only: the pane's `o` uses your own `gh` login in your session. Without both tokens, filing is off ([Filing notes as issues](docs/phone.md#filing-notes-as-issues)).
- **Notes aren't encrypted.** They're stored as plain SQLite and Markdown files. Don't jot secrets.

## Scope

Ostrakon is a Claude Code mod, and it runs with your user's permissions. Its data lives in the notes folder, the mirror folder if you set one, the cache at `~/.cache/ostrakon`, and the hub you point it at.
