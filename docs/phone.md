# Ostrakon on the phone

The hub (`server/hub.ts`) serves a small web app for your phone. Write a note, pick a project (or
leave it `unfiled`) and tap Save; the note shows up in every open ostrakon pane within a couple of
seconds.

Below the note field is your inbox of open notes, grouped by project as in the pane. Each project's
heading has the same colour the pane gives it, and `unfiled` comes last. `◆` marks a note from
Claude, `▪` one from the phone.

- **Fold a project**: tap its heading. The phone remembers which are folded, and a search still
  finds notes in folded groups. A heading stays at the top of the screen while you scroll its group.
- **Edit**: tap a note.
- **Archive**: swipe a note left. A strip behind it says `Archive` and turns solid when letting go
  will archive it.
- **More actions**: hold a note for about half a second for **Edit**, **Copy text**, **Move to
  project…**, **Mark sent** (for a note you used somewhere else) and **Archive**. Tap outside the
  sheet to close it.

Moving, archiving and marking sent can all be undone from the message that pops up afterwards.

**It works offline.** Saving never waits for the network: notes are queued on the phone and sent
as soon as the hub answers. Until then the page shows something like `Offline · 2 queued` and
keeps trying. Your inbox is kept on the phone too, and the app opens straight away even when the
hub is down.

**Nothing gets lost.** If the hub turns a note down (it failed one of the hub's checks), the note
moves to a **Not accepted by the hub** box above the inbox, with the reason and buttons to
**Copy** or **Dismiss** it. If the phone can't save anything at all (storage full or blocked),
Save says so and leaves your text in the field.

## Open it

Run the hub on a machine that stays on, such as a home server or a desktop that doesn't sleep. The
phone and your other machines keep working while it's down, but nothing syncs until it's back.

The hub only listens on its own machine (`127.0.0.1`), so something has to give it an HTTPS
address your devices can reach. It has to be HTTPS, because a phone can't install a web app
otherwise. Tailscale is the easy option:

```
tailscale serve --bg --https=8443 http://127.0.0.1:8790
```

Then open `https://<host>.<tailnet>.ts.net:8443/` on the phone, for example
`https://my-server.example-tailnet.ts.net:8443/`. The phone has to be on your tailnet, with the
Tailscale app connected.

**Without Tailscale.** Any HTTPS reverse proxy (Caddy, nginx), tunnel (Cloudflare Tunnel, ngrok) or
other VPN in front of `127.0.0.1:8790` works too. Set the proxy's timeout above 30 seconds, because
live sync holds requests open. If your proxy puts the hub on the public internet, only the token
protects it, so read [`SECURITY.md`](../SECURITY.md) first.

## Pair your phone

The hub only answers requests that carry its token (`HUB_TOKEN`). The first time the app opens,
it asks for the token; paste it and tap **Connect**, and the phone remembers it.

**The easy way is a QR code.** On the machine running the hub, run `ostrakon pair` (`./install.sh`
puts the command on your PATH; it needs `qrencode`). Scan the QR code with the phone's camera and
the link opens in Safari, which swaps the code for the token and stores it. The code works once
and expires after 5 minutes, so the QR never contains the token itself. Safari is left on an
address that does contain it (`?token=…`), which is what makes Add to Home Screen work (below).

A few details:

- `ostrakon pair` reads `HUB_TOKEN` from the environment or from `~/.config/ostrakon-hub/env`,
  the service's settings file.
- It looks up the hub's address from Tailscale. Without Tailscale, or if that fails, give it the
  address: `ostrakon pair https://<your hub address>`.
- If the code expired or was already used, the phone's token screen says so; run `ostrakon pair`
  again.
- A phone that opened the app before pairing codes existed may load its old cached copy, which
  doesn't understand them. Open the app once first so it updates.

**If the hub runs on another machine**, or you want a link for a Shortcut, `ostrakon pair --token
[url]` prints a QR code and link that contain the token itself. Treat a screenshot of it like the
token, and clear the terminal after scanning.

**Or type the address yourself** with the token in it. The app stores the token and removes it
from the address bar straight away:

```
https://<host>.<tailnet>.ts.net:8443/?token=<HUB_TOKEN>
```

If you ever change the token on the hub, the app shows the token screen again with `That token was
refused.`

## Add to Home Screen

In Safari, with the app open, tap **Share**, then **Add to Home Screen**, then **Add**. From its
icon it opens full screen, straight to the note field.

On iOS, a Home Screen app doesn't share Safari's storage, so the token has to come along in the
app's start address. That's why pairing leaves Safari on the `?token=` address (it stays on the
phone; nothing is sent anywhere). When you add the app, the hub gives it a start address with the
token in it, and the installed app stores the token and removes it from its own address.

If the installed app still asks for the token, delete it, open the link in Safari, reload once (an
old version may still be cached), and add it again.

## iOS Shortcut: "Jot to ostrakon"

A Shortcut can send a note without opening the app: from the share sheet, from Siri ("Jot to
ostrakon"), or from the Action button. It posts to the hub's `/api/jot`, which takes a line of
text and, optionally, a project (its name, such as `cc`, or its key).

In the **Shortcuts** app:

1. Tap **+** to make a new shortcut. Tap the name at the top and rename it **Jot to ostrakon**.
2. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Under **Share Sheet Types**
   keep only **Text** and **URLs**. Close the details.
3. The first action is **Receive Text and URLs input from Share Sheet**. Tap **If there's no input:
   Continue** and change it to **Ask For** → **Text**. Now when you run it from Siri or the Home
   Screen, it asks for the note, and Siri takes dictation.
4. Add the action **Get Contents of URL**:
   - **URL**: `https://<host>.<tailnet>.ts.net:8443/api/jot`
   - Tap **Show More**. **Method**: **POST**.
   - **Headers**: add one, with key `Authorization` and value `Bearer <HUB_TOKEN>`.
   - **Request Body**: **JSON**. Add a **Text** field with key `text` and the **Shortcut Input**
     variable as its value. (Optional: a second **Text** field with key `project` and value `cc`.)
5. Add the action **Show Notification** with the text `Jotted`, or leave it out to stay silent.

Try it: say "Jot to ostrakon", dictate a note, and it shows up in the pane on your computer within a
couple of seconds. If you get `{"error":"unauthorized"}`, the token in the header is wrong. If it
can't connect, check that the phone can reach the hub (with Tailscale, that the app is connected).

The same thing from a terminal:

```
curl -H 'Authorization: Bearer <HUB_TOKEN>' -d '{"text":"check the backup job"}' https://<host>.<tailnet>.ts.net:8443/api/jot
```
