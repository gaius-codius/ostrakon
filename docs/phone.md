# Ostrakon on the phone

The hub (`server/hub.ts`) serves a small capture page. Tap the note field and write; project
chips come up under it, the project you used last first. Tap one to file the note there (tap it
again for `unfiled`, the default), or `N more` for the full list with a search. Save, and the note
lands in every open ostrakon pane within a couple of seconds; the form says `✓ saved · waiting to
sync` until the hub has it. **Close** puts the form away and keeps what you typed.

Below the form is the inbox of open notes, grouped by project as in the pane: each heading has the
project's dot, its name and how many notes it holds, `unfiled` last. `◆` marks a note from
Claude, `▪` one from the phone. Notes Claude proposed (harvest) come first under **Proposed by
Claude**, with **Keep** and **Dismiss**. A heading stays at the top while you scroll its group; tap
it to fold the group (the phone remembers which are folded). The search button at the top filters
open notes, folded groups included.

Tap a note to edit it. Each row has a `⋯` button (or hold the note still for about half a second)
for its actions: **Edit**, **Copy text**, **Move to project** (the same list as the form's), **Mark
sent** (for a note you used somewhere else) and **Archive**, then **Cancel**. Swipe a note left to
archive it: a strip behind the row says `Archive` and turns solid while letting go will archive;
change your mind and drag back right, and the row springs home. A move, Mark sent and Archive each
come with Undo in the toast.

Saving never waits for the network. Notes go into a queue on the phone and are sent as soon as the
hub answers; while it can't, the page says `hub offline · 2 queued` and keeps trying. The inbox is
kept on the phone too, so it still shows when you're offline, and the page itself (fonts and all)
opens from the phone's cache straight away even when the hub is down.

A note the hub won't accept (it fails the hub's checks) isn't thrown away: it stays in a box above
the inbox, `The hub wouldn't take 1 note`, with the hub's reason and **Edit**, **Retry** and
**Discard local copy**. If the phone can't store anything (storage full, or blocked), Save says so
and leaves your text in the field.

The page follows the phone's light or dark setting, its text size, and Reduce Motion.

## Open it

The hub listens on `127.0.0.1` only. `tailscale serve` puts it on the tailnet over HTTPS, which an
installable web app needs:

```
tailscale serve --bg --https=8443 http://127.0.0.1:8790
```

Then open `https://<host>.<tailnet>.ts.net:8443/` on the phone, for example
`https://my-server.example-tailnet.ts.net:8443/`. The phone has to be on the tailnet (the Tailscale app
connected).

## First run: the token

Every `/api` call carries the hub's token (`HUB_TOKEN` in the hub's environment). The first time
the page opens it shows **Connect this phone** with the pairing steps below. To paste the token
instead, open **Paste a hub token instead**, paste it and tap **Connect**; it's kept on the phone.

Easiest: on the hub host, run `ostrakon pair` (`./install.sh` puts the command on your PATH). It
asks the running hub for a one-time code and prints a QR code of a link that carries it; the phone
camera opens the link in Safari. The code works once and expires after 5 minutes. The page trades
it for the token, stores the token, and reloads with the `?token=` address in Safari so Add to
Home Screen works (below). The QR itself never carries the token. It takes `HUB_TOKEN` from the
environment or from `~/.config/ostrakon-hub/env`, the systemd unit's file. If it can't find this
machine's Tailscale name, pass the hub's address: `ostrakon pair https://<host>.<tailnet>.ts.net:8443`.
It needs `qrencode`. If the code has expired or was used, a phone that isn't paired yet says so on
the Connect this phone screen; run `ostrakon pair` again. A phone that had the page before pairing codes existed
may open its old cached copy, which doesn't know them: open the page once first so it updates.

The fallback is `ostrakon pair --token [url]`, which prints a QR code and link that carry the token
itself (use it when the hub isn't running on this host, or to make a Shortcut link). Treat a
screenshot of that like the token, and clear the terminal after scanning.

Or open the page once with the token in the address, and it's stored and removed from the
address bar straight away:

```
https://<host>.<tailnet>.ts.net:8443/?token=<HUB_TOKEN>
```

If the token is ever changed on the hub, the page shows the Connect this phone screen again, with
`That token was refused.`

## Add to Home Screen

In Safari, with the page open: the **Share** button, then **Add to Home Screen**, then **Add**. It
opens full screen from its icon, straight into the note field.

iOS gives a Home Screen app storage of its own, apart from Safari's, so the token has to travel in
the app's start address. Scanning the pairing QR leaves Safari on the `?token=` address (the token
stays in the address bar there, on the phone only); or open that link yourself. Then add it: the page asks the hub for its manifest with the token, and the hub answers
with a start address that carries it. The installed app stores the token and takes it out of its
own address bar. If the installed app still asks for the token, remove it, open the link in Safari,
reload once (the old version may still be cached), and add it again.

## iOS Shortcut: "Jot to ostrakon"

A Shortcut can send a note from the share sheet, from Siri ("Jot to ostrakon"), or from the
Action button, without opening the page. It posts to `/api/jot`, which takes one line of text and
an optional project (its name, for example `cc`, or its key).

In the **Shortcuts** app:

1. Tap **+** to make a new shortcut. Rename it (tap the name at the top) to **Jot to ostrakon**.
2. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Under **Share Sheet Types**
   keep only **Text** and **URLs**. Close the details.
3. The first action is **Receive Text and URLs input from Share Sheet**. Tap **If there's no input:
   Continue** and change it to **Ask For** → **Text** (when you run it from Siri or the Home Screen
   it asks, and Siri takes dictation).
4. Add the action **Get Contents of URL**:
   - **URL**: `https://<host>.<tailnet>.ts.net:8443/api/jot`
   - Tap **Show More**. **Method**: **POST**.
   - **Headers**: add one. Key `Authorization`, value `Bearer <HUB_TOKEN>`.
   - **Request Body**: **JSON**. Add a field: type **Text**, key `text`, value the
     **Shortcut Input** variable. (Optional: a second **Text** field, key `project`, value `cc`.)
5. Add the action **Show Notification** with the text `Jotted` (or leave it out to stay silent).

Try it: say "Jot to ostrakon", dictate a note, and it shows in the pane on the computer within a
couple of seconds. If it answers `{"error":"unauthorized"}`, the token in the header is wrong; if
the action fails to connect, check that Tailscale is connected on the phone.

The same call from a terminal:

```
curl -H 'Authorization: Bearer <HUB_TOKEN>' -d '{"text":"check the backup job"}' https://<host>.<tailnet>.ts.net:8443/api/jot
```
