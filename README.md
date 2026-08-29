# Rota App — Personal Shift & Pay Tracker

A self-hosted Node.js web application for tracking your work shifts, pay, leave, and colleagues. Runs in Docker on TrueNAS and is accessible from any device on your local network.

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Accessing the App](#accessing-the-app)
4. [Features](#features)
   - [Shifts](#shifts)
   - [Payslips](#payslips)
   - [Pay Rates](#pay-rates)
   - [Reports](#reports)
   - [Leave](#leave)
   - [Calendar](#calendar)
   - [Colleagues & Working With](#colleagues--working-with)
   - [Import](#import)
   - [Settings](#settings)
   - [Backup & Restore](#backup--restore)
   - [Notifications (ntfy)](#notifications-ntfy)
   - [V3.0 Features](#v30-features)
5. [Deployment on TrueNAS](#deployment-on-truenas)
   - [File Structure](#file-structure)
   - [How to Update the App](#how-to-update-the-app)
   - [Restarting the Container](#restarting-the-container)
   - [Viewing Logs](#viewing-logs)
   - [Checking Container Status](#checking-container-status)
   - [Accessing the Database Directly](#accessing-the-database-directly)
6. [docker-compose.yml Reference](#docker-composeyml-reference)
7. [Database Schema Summary](#database-schema-summary)
8. [API Reference](#api-reference)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The Rota App is a personal tool built for Ed Kay (Screwfix) to:

- Log and track every shift worked, including break details, mileage, and bank holiday status
- Record payslips with full breakdown (basic pay, additional hours, tax, NI, YTD figures)
- Track annual leave and sick leave
- Compare your calculated pay against actual payslip figures
- Analyse patterns in your rota (early starts, late finishes, weekend frequency)
- Track colleagues' shifts and who you work with most
- Import your rota directly from Rotageek (via login, bookmarklet, or screenshot OCR)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 18 / Express |
| Database | SQLite via `better-sqlite3` |
| Frontend | Vanilla HTML/CSS/JS (single page app) |
| Container | Docker (image: `node:18`) |
| Host | TrueNAS — container name `screwfix-rota` |
| OCR | Tesseract.js (for screenshot imports) |

---

## Accessing the App

Once the container is running, open a browser and go to:

```
http://<your-truenas-ip>:3000
```

For example: `http://192.168.1.x:3000`

The app is a single-page application — all navigation happens within the one page without full reloads.

---

## Features

### Shifts

The core of the app. Every shift you work is stored here.

**Fields per shift:**
- Date, start time, end time
- Break: scheduled minutes (default 30), and whether you took `full`, `partial`, or `none` of it. If you skip a break, that time is added back to your pay calculation (break unused pay)
- Distance in miles (defaults to your configured default, e.g. 3.6 miles)
- Hourly rate — automatically looked up from your Pay Rates history based on the shift date
- Hours worked — calculated automatically from start/end/break
- Calculated pay — hours × rate (doubled on bank holidays)
- Bank holiday flag — doubles the hourly rate
- Notes — free text
- Completed flag — used to separate upcoming/planned shifts from worked ones

**How to add a shift:**
1. Go to the **Shifts** tab
2. Click **Add Shift**
3. Fill in the date, start time, end time
4. Set break type (full/partial/none) — if partial, enter how many minutes you actually took
5. Tick **Bank Holiday** if applicable
6. Click **Save**

**Marking shifts as complete:**
- Tick the complete checkbox on a shift, or use the **Bulk Complete** button to mark multiple at once
- When completing, you can override the break taken — useful if a shift ended differently than planned

**Bulk mileage update:**
- Select multiple shifts and set the same mileage for all of them at once

**Break policy (what the scheduled break should be):**

The break a shift is entitled to depends on its length. The boundaries are strict — an
exactly 8h00 shift gets 30 minutes, not 45.

| Shift length | Scheduled break |
|--------------|-----------------|
| 4h30 or less | none |
| over 4h30, up to 6h | 15 min |
| over 6h, up to 8h | 30 min |
| over 8h | 45 min |

This is what `autoBreakMinutes()` in `server.js` implements, what the break audit on the
Shifts tab compares against, and what the Data Doctor uses to work out whether a shift's
hours or its break field is the one that has gone stale.

**Break unused pay:**
When you take `none` as your break, the app adds the scheduled break minutes back as paid time. The monthly report shows how much extra pay this generates.

---

### Payslips

Record your actual payslips so you can cross-reference them against your calculated pay.

**Fields recorded:**
- Month (YYYY-MM), payment date
- Basic pay, arrears pay
- Additional hours (quantity and pay) — both current and previous period
- Annual leave adjustments (current and previous period)
- Bank holiday pay (current and previous period)
- Company sick pay
- SIP (Save as You Earn / SAYE contribution)
- Other payments (with description)
- Sharesave deduction (with description)
- Total gross, total deductions, net payment
- Tax paid, NI (employee and employer)
- Year-to-date figures: gross YTD, taxable YTD, tax YTD, NI-able YTD
- Notes

**How to add a payslip:**
1. Go to **Payslips** tab
2. Click **Add Payslip**
3. Fill in the month and all the figures from your actual payslip
4. Save — the app will show the difference between your calculated pay and what you were actually paid

---

### Pay Rates

A history of your hourly rate and contracted hours, with effective dates. The app automatically picks the right rate for each shift's date.

**Pre-seeded rates:**
- From 2024-01-01: £12.55/hr, 14h/week
- From 2025-04-01: £13.48/hr, 14h/week
- From 2025-11-01: £13.48/hr, 20h/week

**How to add a new rate (e.g. after a pay rise):**
1. Go to **Settings** → **Pay Rates** section
2. Click **Add Rate**
3. Enter the effective date (the first date the new rate applies), the new hourly rate, and your contracted weekly hours
4. Save — all shifts from that date onwards will automatically use the new rate

---

### Reports

Multiple report views let you understand your earnings and patterns.

#### Monthly Report
A table showing each month with:
- Shifts worked / scheduled shifts
- Hours worked
- Calculated pay (from your shifts)
- Leave hours and leave pay
- Distance driven
- Contracted hours for that month
- Break stats (breaks taken vs skipped, and skipped break pay)
- Actual payslip figures (if entered) for comparison

#### Yearly Summary
Year-by-year totals: shifts, hours, calculated pay, gross paid, net paid, tax, NI.

#### Weekly Report
Week-by-week view showing hours worked vs contracted hours. Useful for spotting under/over-contracted weeks.

#### Summary Report
A high-level summary for any date range, covering total shifts, total hours, total calculated pay, total gross/net paid.

#### Insights
Detailed statistics for a selected year (or all time):
- Top 5 most common shift times
- Most common colleagues you work with
- Early starts (06:45) vs late finishes per week
- Delivery shifts per week
- Weekend shifts per month (Saturdays and Sundays)
- Distinct weekends worked
- Day-of-week breakdown (how often you work each day)
- Average, max, min shift duration
- Longest and shortest shift details
- Best week (highest earnings)
- Longest working streak (excluding leave days)
- Annual leave days taken in the year

Insights can also be filtered to show a specific colleague's patterns by clicking their name on the Colleagues page.

---

### Leave

Track annual leave and sick leave.

**Fields:**
- Start date, end date
- Days taken (weekdays only, calculated automatically for multi-day entries)
- Hours taken (calculated from your configured hours-per-day setting)
- Leave type: `annual` or `sick`
- Notes

**Leave year:**
The leave year start date is configurable in Settings (defaults to 1st April). The leave tracker shows your entitlement, how much you've used, and what remains — both in days and hours.

**ICS import:**
All-day events in an ICS calendar file are automatically treated as leave when importing.

---

### Calendar

A monthly calendar view showing:
- Your upcoming and worked shifts (colour-coded)
- Leave days
- Colleagues working on each day (if team rota data has been imported)
- Calendar notes — click any day to add a free-text note visible on that date
- A link to add the current calendar view to your device's calendar app

Navigate months using the arrows. Click any shift to view or edit it.

#### Live calendar subscription

`GET /calendar.ics` serves a live iCal feed — 90 days back, 12 months forward — so a
phone calendar stays in sync without re-exporting. The URL to subscribe to is shown on
the **Export** page. On iPhone: Settings → Calendar → Accounts → Add Subscribed
Calendar. On Google Calendar: Other calendars → From URL.

**If the app is behind Cloudflare Access, the subscription will not work.** Calendar
apps can't complete an interactive login, so Access answers their request with its
sign-in page and the client sees no calendar data. This is the same reason the NFC
clock-in tag fails from outside the network. Nothing in the app can work around it —
the request is intercepted before it ever reaches the container.

The fix is to exempt just that one path in Cloudflare Zero Trust:

1. Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**
2. Set the domain to your existing hostname with the path `calendar.ics`
   (e.g. `schedule.example.uk` / `calendar.ics`)
3. Add one policy: **Action = Bypass**, **Include = Everyone**
4. Save. A more specific path takes precedence over the application covering the
   whole hostname, so the rest of the app stays behind Access.

That path is then reachable by anyone who knows the URL, so protect it with a token —
**Export → Live calendar subscription → Token protection → Generate token**. The
subscription URL becomes `/calendar.ics?token=<value>`, and requests without the exact
token get a 403. The token lives in the `settings` table under `ical_token`; the
`ICAL_TOKEN` env var still works as a fallback for values not set in the app.

Repeat steps 1–4 with the path `clock-tap` if you want the NFC tag to work from
outside your network too — it already has its own token, set in Settings → NFC
Clock In/Out.

---

### Colleagues & Working With

Track who you work with and analyse colleague patterns.

#### Colleagues List
- Add colleagues by name
- Set a start date and birthday per colleague
- Mark colleagues as departed (left date) — they are hidden from active views but kept in history
- Set a sort order for the display
- Set contract hours per colleague

#### Working With (on shift form)
When adding or editing a shift, you can select which colleagues you worked with from a picker. This is the manual way of logging working-with data.

#### Team Calendar
A view showing all colleagues' shifts in a weekly calendar format, with weekly hours per person.

#### Leaderboard
A ranked table of colleagues by: number of shared shifts, hours worked together, and percentage of your shifts they appeared on.

#### Next Shifts Together
Predictions of the next time you and each colleague will be working the same shift, based on imported team rota data.

#### Insights per Colleague
Click a colleague's name to see their own Insights view — shift patterns, most common shift times, weekend counts, etc.

---

### Import

Several ways to get your rota data into the app.

#### ICS / iCalendar Import
If you have a `.ics` calendar export from any source:
1. Go to **Import** tab → **ICS Import**
2. Paste or upload the ICS file content
3. Preview the detected shifts and leave entries
4. Confirm to import — duplicates are automatically skipped

All-day ICS events become leave entries. Timed events become shifts. Breaks are auto-calculated based on shift length (≤4h = none, 4–6h = 15 min, >6h = 30 min).

#### CSV Import (My Shifts)
Import your own shifts from a spreadsheet:
1. Go to **Import** → **CSV Import**
2. Paste or upload a CSV
3. Use the column mapping tool to match your CSV headers to the app's fields (date, start_time, end_time, etc.)
4. Set the header row number if your CSV has preamble rows
5. Preview and import — duplicates are skipped automatically

**Supported date formats:** `YYYY-MM-DD`, `DD/MM/YYYY`, `D/M/YY`, `"Mon, 1 Sep"`, `"1 September 2024"`, and Excel serial dates.
**Supported time formats:** `HH:MM`, `HH:MM:SS`, `H:MM AM/PM`, and Excel decimal fractions.

#### CSV Import (Payslips)
Same process as above but maps payslip columns instead of shift columns.

#### Rotageek Live Import
Login to Rotageek directly within the app and pull your shifts in real time.

1. Go to **Import** → **Rotageek Live**
2. Enter your Rotageek username and password, or paste a Bearer token (see below for how to get a token)
3. Once authenticated, your upcoming shifts are fetched and previewed
4. Select which shifts to import and click **Import Selected**

**Getting a Bearer token (if login fails):**
- Open Rotageek in Chrome, open DevTools (F12), go to the Network tab
- Refresh the page and look for any API request to `rotageek.com`
- In the request headers, find `Authorization: Bearer xxxxxxx`
- Copy just the token part (after "Bearer ") and paste it into the token field

#### Rotageek Bookmarklet
A small JavaScript snippet you drag to your browser's bookmarks bar. When you click it on the Rotageek website, it reads your shift data from the page and copies it to the clipboard as JSON. Then paste that JSON into the app's **Import** → **Paste JSON** tab.

Instructions for installing the bookmarklet are shown in the Import page.

#### Screenshot OCR Import (Team Rota)
Import your colleagues' shifts by taking screenshots of the Rotageek team rota view:
1. Take screenshots of the team rota on your phone or browser
2. Go to **Import** → **Screenshot OCR**
3. Upload one or more screenshots
4. The app runs OCR on each image using Tesseract.js, identifies names and shift times, and fuzzy-matches them against your colleagues list
5. Review the parsed results and confirm

The OCR handles common noise from Rotageek's calendar layout (day headers, "All day" labels, leave markers).

#### F12 Session Method (Team Rota)
The most reliable way to pull the full team rota:
1. Open Rotageek in a browser, log in, and open DevTools (F12)
2. In the Application/Storage tab, find your session cookie (usually `_rotageek_session` or similar)
3. Also find the CSRF token from a request header (`X-CSRF-Token`)
4. Paste both into the Import page's **F12 Session** tab
5. The server will probe Rotageek's API endpoints using your session credentials and fetch team shift data for the week range you choose

#### JSON Paste (GraphQL / Team Scraper Bookmarklet)
If you've used the GraphQL bookmarklet or Team Scraper bookmarklet to extract JSON from Rotageek, paste it directly into the **Paste JSON** tab and the app will parse it.

---

### Settings

Found in the **Settings** tab. Configurable options include:

| Setting | Description |
|--------|-------------|
| Employee name | Your name (used in exports) |
| Employer | Your employer name |
| Default distance miles | Default mileage applied to new shifts (e.g. 3.6) |
| Default break minutes | Default scheduled break (e.g. 30) |
| Job start date | Your employment start date — shown with milestone countdown |
| Annual leave entitlement | Days entitlement per leave year (default 28) |
| Annual leave hours | Total hours entitlement (alternative to days) |
| Leave year start | First day of your leave year (default 04-01 = 1 April) |
| Hours per day | Used to convert hours ↔ days for leave (default 7.4) |
| Delivery days | Which days of the week deliveries run (used in Insights) |
| ntfy topic/server | Push notification settings (see Notifications section) |
| Rotageek credentials | Stored token and base URL for Rotageek API |

**Pay Rates** are also managed from Settings (add, edit, delete rate history entries).

**Delivery Schedules** let you define which days deliveries happen from a given date, with support for multiple schedule periods as the rota changes.

---

### Backup & Restore

#### Creating a Backup
1. Go to **Settings** → **Backup & Restore**
2. Click **Download Backup**
3. A JSON file is downloaded named `rota-backup-YYYY-MM-DD.json`

The backup includes: all shifts, payslips, pay rates, leave entries, settings, and calendar notes.

#### Restoring a Backup
1. Click **Restore from Backup**
2. Select your backup JSON file
3. **Warning: this completely replaces all current data.** There is no merge — it's a full wipe and reload.

It is recommended to take a backup before any major import or change.

#### Automatic offsite backup (GitHub)

The server already snapshots the whole SQLite database every night into `data/backups` (kept for 14 days). It can also push each nightly snapshot to a GitHub repo — so you have an offsite copy if the host disk is lost.

Note what this does **not** cover: uploaded files live on disk next to the database, not inside it — rota screenshots in `data/photo-library/` and payslip PDFs in `data/payslip-files/`. The nightly snapshot carries `rota.db` alone, so those files are only as safe as whatever backs up the `data/` volume itself.

Easiest way: go to **Settings → Backup & Restore → Offsite backup (GitHub)** and fill in:

| Field | Required | Description |
|---|---|---|
| Repo | yes | `owner/repo` to push into (use a **private** repo — the pushed files are full database dumps) |
| Personal access token | yes | A GitHub PAT with `contents: write` on that repo (fine-grained tokens work). Stored in the database, never shown back to you |
| Branch | no | Branch to commit to (default `main`) |
| Folder | no | Folder within the repo (default `backups`) |

Click **Save** — no restart needed. "Back up now" will push immediately, and the repo folder mirrors the same 14-backup retention as the local copy.

Alternatively, the same four values can be set as environment variables (`GITHUB_BACKUP_REPO`, `GITHUB_BACKUP_TOKEN`, `GITHUB_BACKUP_BRANCH`, `GITHUB_BACKUP_PATH` — see the commented-out example in `docker-compose.yml`); a value entered in Settings always takes priority over the matching env var.

Once set, restart the container. The **Settings → Backup & Restore** page shows whether GitHub backup is enabled, and "Back up now" pushes immediately. The repo folder mirrors the same 14-backup retention as the local copy — older files are deleted automatically. Use a **private** repo, since the pushed files are full database dumps.

---

### Notifications (ntfy)

The app can send push notifications to your phone using [ntfy](https://ntfy.sh) — a free, open-source notification service.

**Setup:**
1. Install the ntfy app on your phone
2. Subscribe to a topic name you choose (e.g. `myrotaapp-ed`)
3. In the app's Settings, set:
   - **ntfy topic**: your topic name
   - **ntfy server**: `https://ntfy.sh` (or your self-hosted ntfy URL)
   - **ntfy enabled**: tick to enable
4. Notifications are sent for events like successful Rotageek imports

---

### V3.0 Features

Twenty-four extra views under the **✨ V3.0 Features** section of the sidebar. They are all
read-only lenses on data the app already holds — apart from the Goal Tracker, none of
them ask you to enter anything new, and nothing here changes an existing shift.

| Feature | What it does |
|---------|--------------|
| 💸 **Money Clock** | Live earnings ticker for the shift you're currently on, plus today/week/month/year/lifetime totals and a countdown to payday (inferred from your real payslip dates). |
| ⏳ **Countdown Board** | Next shift, home time, next day off, payday, booked leave, bank holiday, birthdays and work anniversary — all ticking live on one board. |
| 🎯 **Goal Tracker** | Set a money, hours or shifts target. Tracks progress from real shifts, projects a finish date from your actual pace, and tells you whether the rota you've already got booked gets you there. |
| 🔮 **Pay Forecast** | Projects the tax year to 5 April — gross, income tax, NI and take-home — built from banked payslips, worked-but-unpaid shifts, booked rota and a contracted-hours estimate for the rest. Includes your "tax freedom day". |
| 🏆 **Trophy Cabinet** | 31 achievements that unlock automatically from your history, across four rarity tiers, with progress bars on the locked ones. |
| 📖 **Record Book** | Personal bests: longest shift, earliest start, latest finish, biggest week, biggest payslip, longest run of days worked, and lifetime totals. |
| 🧬 **Shift DNA** | Six traits scored from the shape of your rota (Early Bird, Night Owl, Endurance, Consistency, Variety, Sociability) resolving to an archetype like "The Closer" or "The Weekend Warrior". |
| ⚖️ **Work-Life Balance** | A 0–100 sustainability score over the last N weeks, broken into rest days, weekends off, turnaround time, breaks and longest run — plus an hours-vs-contract trend. |
| ☕ **Break Debt** | Pay always deducts the *scheduled* break, so any break you skipped is unpaid time. This totals those minutes, prices them, and tracks whether it's getting better or worse. |
| ⛽ **Commute Cost** | Fuel, wear and parking for the drive to work, and how many minutes of every shift you work purely to cover it. Car settings live in the view itself. |
| 📼 **On This Day** | What you were doing on this date in previous years — the shift, the crew, the pay, any note — plus milestones landing today. |
| 🎒 **Shift Briefing** | Your next shift on one card: who's on with you, what it pays, the turnaround from your last shift, whether it's a delivery day, and how that exact slot has usually gone. |
| ⏰ **Overtime Tracker** | Hours above (or below) contract per week, what the extra is worth, and what share of your pay depends on shifts you were never contracted to do. |
| 📈 **Pay Rise History** | Every rate change with its percentage, the gap since the last one, what each was worth per week, and how you sit against the National Living Wage. |
| 🥊 **Head to Head** | Your rota against one colleague's, measured like for like, plus how much time you've actually spent on the floor together. |
| 📊 **Year in Numbers** | Every year side by side with the change on the year before. The current year is compared on its projection, not its part-year total. |
| 💡 **Did You Know** | Oddball facts dug out of your own data — the day you've never worked, who you've only ever shared a Tuesday with, your mileage in laps of the M25. |
| 🎲 **Rota Bingo** | A 5×5 card for the week whose squares tick themselves from real shifts. The card is dealt from the week's date, so it's the same card every time you look at that week. |
| 🏖️ **Leave Optimiser** | Ranks possible leave bookings by how many days off each one actually buys — a day that bridges two rest weekends is worth several. Reads the published rota where it exists and your own weekday pattern past that, labelling which is which, and flags a bank holiday you'd be giving up double pay on. |
| 🔁 **Cover Finder** | Pick a shift and see who could realistically take it, in the order worth asking: free that day, works that slot anyway, has room under their contract, still active on the rota. Every score shows its reasoning, and it also finds shifts of theirs you could take in exchange. |
| 🧾 **Pay Audit** | Hours worked against hours paid, as running totals from the start of the tax year so the month-in-arrears timing can't hide a gap. Models the real pay rules — fixed monthly basic, extra hours counted per week — and carries a margin, so only a shortfall that clears it is called one. |
| 💷 **Tax Check** | Every payslip against what cumulative PAYE should have deducted, plus NI checked per period. Works the allowance back out of the deductions to say what tax code they imply, which is how an emergency code shows itself. Not tax advice. |
| 🩺 **Data Doctor** | Thirteen integrity checks in one pass: duplicate shifts, bank holidays left unflagged and paying single time, weeks that never imported, hours left stale by an edit, clock records that don't match the rota. Read-only — it points, the existing tools fix. |
| 🔮 **Rota Crystal Ball** | Projects a week the rota hasn't reached yet — which days, which half of the day, roughly what hours and pay. Backtested on six months of real weeks and reported next to what you'd score by just assuming you work every day (70% vs 58% on the author's data). |

**Where the code lives.** V3 is deliberately self-contained so it can be changed or removed
without disturbing the rest of the app:

```
v3/                    server: one router per feature, mounted at /api/v3
  index.js             mounts every feature; the FEATURES list is the single source of truth
  helpers.js           shared date/pay/number helpers
  stats.js             one-pass career stats shared by trophies/records/DNA
  schema.js            V3-owned tables only, all prefixed v3_
public/js/v3/          client: one view per feature
  v3core.js            V3 namespace, API surface, shared render helpers, view registry
public/css/v3.css      V3 styles, all scoped to .v3-*
```

`server.js` gains one `require` and one `app.use('/api/v3', v3Router)`. `app.js` looks V3 views
up in the registry rather than naming them, so adding a thirteenth feature needs no router change.

---

## Deployment on TrueNAS

### File Structure

```
TrueNAS filesystem
└── /mnt/Applications/RotaApp/        ← all app files live here
    ├── server.js                      ← main Express server
    ├── db.js                          ← SQLite schema & helpers
    ├── working-with.js                ← colleagues/OCR routes
    ├── package.json                   ← Node dependencies
    ├── docker-compose.yml             ← Docker config
    ├── public/
    │   ├── index.html                 ← single-page frontend
    │   ├── css/style.css
    │   └── js/
    │       ├── app.js                 ← main frontend logic
    │       ├── shifts.js
    │       ├── calendar.js
    │       ├── reports.js
    │       ├── import.js
    │       ├── payslips.js
    │       ├── settings.js
    │       ├── leave.js
    │       ├── notes.js
    │       ├── export.js
    │       ├── api.js
    │       └── utils.js
    └── data/
        ├── rota.db                    ← SQLite database (persisted via Docker volume)
        ├── photo-library/             ← uploaded rota screenshots (files on disk, metadata in the db)
        └── payslip-files/<YYYY-MM>/   ← uploaded payslip PDFs, kept as-is and never read
```

The `data/` directory (containing `rota.db`) is stored in a named Docker volume called `rota-data`, which means the database **survives container restarts and image changes**.

---

### How to Update the App

There is **no build step** — the container mounts the files directly from TrueNAS. Updating is simply copying the new files across and restarting the container.

#### Step 1 — Copy updated files to TrueNAS

On your Windows machine, copy the updated file(s) from:
```
E:\3) Documents\07) Personal Documents\Rota App\Rota App\Server Code\
```
to TrueNAS at:
```
/mnt/Applications/RotaApp/
```

You can do this via:
- **Windows file share**: Map TrueNAS as a network drive (SMB share) and copy/paste files directly in File Explorer
- **SCP**: `scp server.js admin@<truenas-ip>:/mnt/Applications/RotaApp/`
- **TrueNAS web UI**: Files → navigate to `/mnt/Applications/RotaApp/` and upload

#### Step 2 — Update the container

SSH into TrueNAS and run:

```bash
cd /mnt/Applications/RotaApp
sudo docker build --no-cache -t rota-app .
```

The container will restart with the new files. It typically takes 5–10 seconds. Node will automatically install any new npm packages declared in `package.json` on startup (the start command runs `npm install --production && node server.js`).


---

### Accessing the Database Directly

The SQLite database is at `/mnt/Applications/RotaApp/data/rota.db` on TrueNAS (also accessible inside the container at `/app/data/rota.db`).

**Run SQLite queries directly:**
```bash
sudo docker exec -it screwfix-rota sh
# then inside the container:
sqlite3 /app/data/rota.db
```

Useful SQLite commands once inside:
```sql
-- List all tables
.tables

-- Count shifts
SELECT COUNT(*) FROM shifts;

-- View recent shifts
SELECT date, start_time, end_time, hours_worked, calculated_pay
FROM shifts ORDER BY date DESC LIMIT 20;

-- Check settings
SELECT * FROM settings;

-- Exit
.quit
```

**Copy the database file off the container** (for a manual backup):
```bash
sudo docker cp screwfix-rota:/app/data/rota.db /mnt/Applications/rota-backup.db
```

---

## docker-compose.yml Reference

```yaml
version: '3.8'

services:
  rota-app:
    image: node:18
    container_name: screwfix-rota
    working_dir: /app
    command: sh -c "npm install --production && node server.js"
    ports:
      - "3000:3000"
    volumes:
      - /mnt/Applications/RotaApp:/app        # app files — edit these to update the app
      - rota-data:/app/data                   # database — persisted in named volume
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3000

volumes:
  rota-data:
    driver: local
```

Key points:
- `restart: unless-stopped` — the container auto-starts when TrueNAS boots
- Port `3000` on the host maps to port `3000` inside the container
- The named volume `rota-data` persists the database independently of the app files
- `npm install --production` runs on every startup, so adding a new package to `package.json` is picked up automatically after a restart

**To bring up the app from scratch** (e.g. first deploy or after recreating):
```bash
cd /mnt/Applications/RotaApp
sudo docker-compose up -d
```

**To bring it down:**
```bash
sudo docker-compose down
```

Note: `docker-compose down` does **not** delete the `rota-data` volume or the database. To also remove the volume (full wipe): `docker-compose down -v` — **use with caution**.

---

## Database Schema Summary

| Table | Purpose |
|-------|---------|
| `shifts` | Every shift: date, times, break, pay, mileage, completion status |
| `payslips` | Actual payslip records per month with full breakdown |
| `pay_rates` | Hourly rate history with effective dates and contracted hours |
| `leave_entries` | Annual leave and sick leave records |
| `settings` | Key-value config (employee name, defaults, ntfy, Rotageek credentials) |
| `calendar_notes` | Free-text notes attached to specific dates |
| `colleagues` | Colleague names with optional start date, birthday, left date, contract hours |
| `colleague_shifts` | Colleagues' shift records (imported from Rotageek or OCR) |
| `shift_audit_log` | Immutable log of every create/update/delete action on shifts |
| `ocr_jobs` / `ocr_job_files` | Background job queue for screenshot OCR processing |
| `photo_folders` / `photo_files` | Uploaded rota screenshots — metadata here, files on disk under `data/photo-library/` |
| `payslip_files` | Uploaded payslip PDFs — metadata here, files on disk under `data/payslip-files/` |
| `clock_entries` | Clock-in / clock-out times per day |
| `delivery_schedules` | History of which days delivery shifts run |
| `tax_refunds` | Tax refund records by tax year |

The database uses **WAL mode** (Write-Ahead Logging) for better concurrent access, and foreign keys are enabled.

Migrations are applied automatically on startup — adding the app to a new server or updating to a version with new columns is handled without any manual steps.

---

## API Reference

All endpoints are under `/api/`. The frontend communicates exclusively via these REST endpoints.

### Shifts
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/shifts` | List shifts — optional `?month=YYYY-MM`, `?year=YYYY`, or `?from=&to=` |
| GET | `/api/shifts/:id` | Get a single shift |
| POST | `/api/shifts` | Create a shift |
| PUT | `/api/shifts/:id` | Update a shift |
| DELETE | `/api/shifts/:id` | Delete a shift |
| PATCH | `/api/shifts/:id/complete` | Mark complete / uncomplete |
| PATCH | `/api/shifts/bulk-complete` | Bulk complete by array of IDs |
| PATCH | `/api/shifts/bulk-mileage` | Bulk set mileage |
| POST | `/api/shifts/recalculate` | Recalculate all hours_worked and calculated_pay |

### Payslips
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/payslips` | List payslips — optional `?year=YYYY` |
| GET | `/api/payslips/:id` | Get one payslip |
| POST | `/api/payslips` | Create payslip |
| PUT | `/api/payslips/:id` | Update payslip |
| DELETE | `/api/payslips/:id` | Delete payslip |
| GET | `/api/payslip-files` | List stored payslip documents — optional `?year=YYYY` |
| POST | `/api/payslip-files` | Upload documents (multipart `files`, plus `month`) |
| GET | `/api/payslip-files/:id` | The file itself — inline, or `?download=1` to save |
| PATCH | `/api/payslip-files/:id` | Retag month, rename, or set a note |
| DELETE | `/api/payslip-files/:id` | Delete the document and its file |

### Pay Rates
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/pay-rates` | List all rates |
| POST | `/api/pay-rates` | Add a rate |
| PUT | `/api/pay-rates/:id` | Update a rate |
| DELETE | `/api/pay-rates/:id` | Delete a rate |

### Reports
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/reports/summary` | Summary totals — optional `?from=&to=` |
| GET | `/api/reports/monthly` | Per-month breakdown — optional `?year=YYYY` |
| GET | `/api/reports/yearly` | Per-year totals |
| GET | `/api/reports/weekly` | Per-week hours — optional `?year=YYYY` |
| GET | `/api/reports/insights` | Pattern stats — optional `?year=YYYY&colleague_id=N` |

### Leave
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/leave` | List leave entries |
| POST | `/api/leave` | Add a leave entry |
| PUT | `/api/leave/:id` | Update leave |
| DELETE | `/api/leave/:id` | Delete leave |

### Colleagues
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/colleagues` | List all colleagues |
| POST | `/api/colleagues` | Add a colleague |
| PUT | `/api/colleagues/:id` | Update colleague |
| DELETE | `/api/colleagues/:id` | Delete colleague |
| GET | `/api/colleagues/next-shifts` | Next shift date per colleague from `?from=YYYY-MM-DD` |
| GET | `/api/working-with/leaderboard` | Shift-count and hours leaderboard |
| GET | `/api/working-with/team-calendar` | Colleague schedule + weekly hours |

### Import
| Method | Endpoint | Description |
|--------|---------|-------------|
| POST | `/api/import/ics-preview` | Parse ICS and return shifts/leave for review |
| POST | `/api/import/ics-shifts` | Import shifts from ICS |
| POST | `/api/import/shifts` | Import shifts from CSV |
| POST | `/api/import/payslips` | Import payslips from CSV |
| POST | `/api/import/preview` | Preview CSV rows and headers |
| POST | `/api/rotageek/auth` | Authenticate with Rotageek (username/password) |
| POST | `/api/rotageek/save-token` | Store a Bearer token manually |

### Other
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/settings` | Get all settings |
| POST | `/api/settings` | Upsert settings (key-value map) |
| GET | `/api/calendar-notes` | Get calendar notes — optional `?month=YYYY-MM` |
| POST | `/api/calendar-notes` | Add/update a calendar note |
| DELETE | `/api/calendar-notes/:id` | Delete a note |
| GET | `/api/backup` | Download full backup as JSON |
| POST | `/api/restore` | Restore from a backup JSON |

### V3.0 Features
| Method | Endpoint | Description |
|--------|---------|-------------|
| GET | `/api/v3/features` | List the V3 feature set |
| GET | `/api/v3/money-clock` | Live earnings state, totals and payday countdown |
| GET | `/api/v3/countdowns` | Every upcoming date with a live ISO target |
| GET | `/api/v3/goals` | Goals with live progress |
| POST | `/api/v3/goals` | Create a goal |
| PUT | `/api/v3/goals/:id` | Update a goal |
| DELETE | `/api/v3/goals/:id` | Delete a goal |
| GET | `/api/v3/forecast` | Tax-year projection — optional `?tax_year=YYYY` |
| GET | `/api/v3/trophies` | Achievements with progress and unlock dates |
| GET | `/api/v3/records` | Personal bests and lifetime totals |
| GET | `/api/v3/shift-dna` | Trait scores and archetype — optional `?year=YYYY\|all` |
| GET | `/api/v3/balance` | Work-life balance score — optional `?weeks=N` |
| GET | `/api/v3/break-debt` | Unpaid break time — optional `?year=YYYY\|all` |
| GET | `/api/v3/commute-cost` | Commute cost — optional `?year=YYYY\|all` |
| POST | `/api/v3/commute-cost/settings` | Save MPG / fuel price / parking / wear |
| GET | `/api/v3/on-this-day` | Same date in previous years — optional `?date=YYYY-MM-DD` |
| GET |  | Next shift briefing — optional  |
| GET |  | Hours beyond contract — optional  |
| GET |  | Rate change history with NLW comparison |
| GET |  | You vs a colleague —  |
| GET |  | Every year side by side |
| GET |  | Derived fun facts — optional  |
| GET |  | Who can be profiled or compared |
| GET | `/api/v3/bingo` | Weekly bingo card — optional `?week=YYYY-MM-DD` |
| GET | `/api/v3/briefing` | Next shift briefing — optional `?date=YYYY-MM-DD` |
| GET | `/api/v3/overtime` | Hours beyond contract — optional `?year=YYYY\|all` |
| GET | `/api/v3/pay-rises` | Rate change history with National Living Wage comparison |
| GET | `/api/v3/head-to-head` | You vs a colleague — `?colleague=<id>` and optional `&year=` |
| GET | `/api/v3/year-in-numbers` | Every year side by side with year-on-year change |
| GET | `/api/v3/did-you-know` | Derived fun facts — optional `?seed=N` |
| GET | `/api/v3/shift-dna/people` | Who can be profiled or compared |
| GET | `/api/v3/leave-planner` | Leave bookings ranked by days off per day booked — optional `?from=`, `?to=`, `?max_span=N` |
| GET | `/api/v3/cover-finder` | Who could cover a shift, plus swap options — optional `?date=YYYY-MM-DD` |
| GET | `/api/v3/crystal-ball` | Projected week with backtested accuracy — optional `?week=YYYY-MM-DD` |
| GET | `/api/v3/pay-audit` | Hours owed vs hours paid, cumulative — optional `?tax_year=YYYY` (the April it starts in) |
| GET | `/api/v3/tax-check` | PAYE and NI checked against the standard bands — optional `?tax_year=YYYY` |
| GET | `/api/v3/health-check` | Data integrity findings, with the offending rows attached |

---

## Troubleshooting

### App won't load in browser
1. Check the container is running: `sudo docker ps | grep screwfix-rota`
2. If not running: `sudo docker start screwfix-rota`
3. Check logs for startup errors: `sudo docker logs --tail 50 screwfix-rota`
4. Confirm port 3000 is not blocked by TrueNAS firewall rules

### App loads but shows errors or blank data
1. Check logs for JavaScript errors or failed API calls
2. Open your browser's DevTools (F12) → Console tab to see any frontend errors
3. Try the Network tab to see which API request is failing and what error it returns

### Database seems corrupted or locked
The database uses WAL mode. If the app crashed mid-write, there may be a WAL file. Simply restarting the container should recover cleanly:
```bash
sudo docker restart screwfix-rota
```
If the database is genuinely corrupt, restore from your most recent backup via Settings → Restore.

### New npm packages aren't installed after updating package.json
The startup command runs `npm install --production` automatically. If packages are missing, restart the container and check the logs — you should see npm output at the top.

### Container restarts on its own
The `restart: unless-stopped` policy means Docker restarts it if it crashes. Check logs to see why it crashed:
```bash
sudo docker logs --tail 200 screwfix-rota
```

### Rotageek login fails
- Try pasting a Bearer token directly (see the Import → Rotageek Live section above for how to get one)
- The token can be extracted from any authenticated request in DevTools Network tab
- Tokens expire — if it worked before but fails now, fetch a fresh one by logging into Rotageek in Chrome with DevTools open

### OCR import matches wrong names
- The fuzzy matcher uses Levenshtein distance — very short names (2–3 characters) may match incorrectly
- Add the colleague's full name in the Colleagues list (not just a first name) for better matching
- Review the OCR preview before confirming the import — you can deselect incorrect matches

### Backup file is empty or very small
An empty backup usually means the app couldn't read the database. Check logs, and verify the `rota-data` volume is properly mounted by running `sudo docker inspect screwfix-rota` and looking at the Mounts section.
