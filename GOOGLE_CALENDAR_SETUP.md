# Google Calendar Sync — Setup

This connects the rota app to your Google Calendar so that whenever a shift is
**added, changed, or deleted** (manually or via a Rotageek sync), the matching
calendar event is created, updated, or removed automatically.

It uses your own Google Cloud OAuth client, so no shift data ever passes through
anyone else's server — the app talks straight to Google from your container.

---

## 1. One-time Google Cloud setup (~10 minutes)

1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Rota App").
2. **Enable the Calendar API:** APIs & Services → Library → search "Google Calendar API" → **Enable**.
3. **OAuth consent screen:** APIs & Services → OAuth consent screen.
   - User type: **External**.
   - Fill in app name + your email where required.
   - **Test users:** add your own Google account (`edwardjwkay@hotmail.com` if that's the Google account, or whichever Gmail/Workspace account holds the calendar).
   - You can leave the app in **Testing** mode — you don't need to publish it for personal use. (Tokens in testing mode can expire after 7 days; if sync stops, just click **Reconnect** in Settings. Publishing the app removes that limit.)
4. **Create credentials:** APIs & Services → Credentials → **Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorised redirect URIs → Add URI:**
     ```
     https://YOUR-DOMAIN/api/google/callback
     ```
     Replace `YOUR-DOMAIN` with the public address you reach the app on (the Cloudflare one). It must match **exactly**, including `https://`.
   - Click **Create**. Copy the **Client ID** and **Client secret**.

---

## 2. Configure the app

> **Important — do this on your PUBLIC https:// address, not the LAN one.**
> Google refuses OAuth redirects to private/LAN IPs like `http://192.168.x.x:3000`
> (you'll see *"Access blocked / device_id and device_name are required for private IP"*).
> Open the app via your public Cloudflare `https://` domain before connecting, so the
> redirect URI is the public one. The only addresses Google accepts are a public
> `https://` domain or `http://localhost`.

1. Open the app **on your public https:// domain** → **Settings → Google Calendar Sync**.
2. Paste in the **Client ID** and **Client secret**.
3. **Authorised redirect URI:** set it to `https://YOUR-DOMAIN/api/google/callback` and
   confirm it matches **exactly** what you registered in Google (step 1.4). The app warns
   you in red if you've entered a LAN/`http` address. The field pre-fills from whatever
   address you opened the app on — so if it shows `192.168.x.x`, replace it with the
   public domain.
4. **Calendar ID:** `primary` is your main calendar. To use a different one, open
   Google Calendar → that calendar's Settings → "Integrate calendar" → copy the
   Calendar ID.
5. **Event title:** what each shift event is called (default "Work shift").
6. Tick **Auto-sync shift changes**.
7. Click **Save settings**, then **Connect Google account**.
8. You'll be sent to Google to approve access. Because the app is in Testing mode
   you'll see an "unverified app" notice — choose **Advanced → Continue** (it's
   your own app). After approving you'll land back on Settings showing **Connected**.
9. Click **Sync future shifts now** to push your existing upcoming shifts across.

---

## 3. The Cloudflare Access note

The OAuth round-trip happens **in your own already-logged-in browser** — Google
redirects *your browser* back to `/api/google/callback`, it does not call your
server directly. So as long as you start the "Connect" flow from a browser that
has already passed the Cloudflare Access OTP, the callback carries your Access
cookie and works with no extra config.

If you ever hit a Cloudflare login wall on the callback, add a **Bypass** rule in
Cloudflare Zero Trust → Access → Applications for just this path:

```
your-domain.com/api/google/callback
```

Bypassing only the callback path is safe: it carries a short-lived, single-use
Google authorisation code and exposes no data.

---

## 4. Install the dependency & redeploy

A new package (`googleapis`) was added to `package.json`. Rebuild so it's installed:

```bash
# in /mnt/Applications/RotaApp (where the source lives)
sudo docker restart screwfix-rota         # if your image runs npm install on boot
# — or rebuild the image if dependencies are baked in:
# sudo docker compose build && sudo docker compose up -d
```

If the Settings page shows *"the googleapis package isn't installed yet"*, the
container is running old `node_modules` — rebuild/`npm install` and restart.

---

## Calendar options (Settings → Google Calendar Sync)

- **Calendar** — pick which calendar shifts go on from the dropdown (refresh it with the ↻ button). Use "Enter ID manually" for a calendar by ID.
- **Event title** — every shift event uses this title (default **Screwfix Shift**) with **no description**.
- **Auto-sync frequency** — optional periodic safety-net re-sync of upcoming shifts (Off / 15 min / 30 min / hourly / 6-hourly / daily). Shift edits always sync instantly regardless.
- **Sync future shifts** / **Sync ALL (incl. past)** — push upcoming, or every shift including past ones (use this to fix historical shifts you've corrected).
- **🧹 Clean up calendar** — re-syncs every shift to the correct day, then deletes any app shift-events that no longer match a shift (e.g. left on the wrong day). Your other calendar events are never touched.
- **Recent calendar activity** — a log of every event created / updated / deleted, so you can see exactly what synced.

## How it behaves

- **Add a shift** → event created; its Google event ID is stored against the shift.
- **Edit a shift** (time/break/notes/completion) → the same event is updated.
- **Delete a shift** → the event is removed from your calendar.
- **Rotageek sync** that adds/changes/removes shifts → mirrored to the calendar too.
- Overnight shifts (end time before start time) correctly span to the next day.
- Calendar calls are **fire-and-forget**: if Google is briefly unreachable, your
  shift still saves normally — re-run **Sync future shifts now** to catch up.
- Turning off **Auto-sync** stops all syncing without disconnecting your account.
