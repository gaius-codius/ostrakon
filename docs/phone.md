# Ostrakon on the phone

The hub (`server/hub.ts`) serves a small capture page: write a note, pick a project (or leave it
`unfiled`), Save. The note lands in every open ostrakon pane within a couple of seconds. Below
the form is the inbox of open notes, grouped by project as in the pane (each project's heading in
the colour the pane gives it, `unfiled` last; `◆` marks a note from Claude, `▪` one from the
phone). A heading stays at the top while you scroll its group; tap it to fold the group (the
phone remembers which are folded; filtering shows matches in folded groups too). Tap a note to edit it, swipe it left to archive
(a strip behind the row says `Archive` and turns solid when letting go will archive; Undo in the
toast). Hold a note still for about half a second and an action sheet comes up: **Edit**, **Copy
text**, **Move to project…** (the same list as the form's picker; the current one is ticked),
**Mark sent** (for a note you used somewhere else) and **Archive**, then **Cancel**. A move, Mark
sent and Archive each come with Undo in the toast. Tap outside the sheet to close it.

Saving never waits for the network. Notes go into a queue on the phone and are sent as soon as the
hub answers; while it can't, the page says `Offline · 2 queued` and keeps trying. The inbox is kept
on the phone too, so it still shows when you're offline, and the page itself opens from the
phone's cache straight away even when the hub is down.

A note the hub won't accept (it fails the hub's checks) isn't thrown away: it moves to a
**Not accepted by the hub** box above the inbox with the reason, a **Copy** button and a
**Dismiss** button. If the phone can't store anything (storage full, or blocked), Save says so and
leaves your text in the field.

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
the page opens it asks for it. Paste it and tap **Connect**; it's kept on the phone.

Easiest: on the hub host, run `ostrakon pair` (`./install.sh` puts the command on your PATH). It
prints a QR code of the link below, and the phone camera opens it in Safari. It takes the token from `HUB_TOKEN` or from
`~/.config/ostrakon-hub/env`, the systemd unit's file. If it can't find this machine's Tailscale
name, pass the hub's address: `ostrakon pair https://<host>.<tailnet>.ts.net:8443`. It needs
`qrencode`. This fits the Add to Home Screen flow below: the scan opens Safari with the token in
the address, then you add the page. The code carries the token, so clear the terminal afterwards.

Or open the page once with the token in the address, and it's stored and removed from the
address bar straight away:

```
https://<host>.<tailnet>.ts.net:8443/?token=<HUB_TOKEN>
```

If the token is ever changed on the hub, the page shows the token screen again with
`That token was refused.`

## Add to Home Screen

In Safari, with the page open: the **Share** button, then **Add to Home Screen**, then **Add**. It
opens full screen from its icon, straight into the note field.

iOS gives a Home Screen app storage of its own, apart from Safari's, so the token has to travel in
the app's start address. Open the `?token=` link in Safari first (the token stays in the address
bar there), then add it: the page asks the hub for its manifest with the token, and the hub answers
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
