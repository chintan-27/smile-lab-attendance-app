# UF Lab Attendance

A modern, cross-platform Electron app for tracking lab attendance with automated daily/weekly reporting and cloud sync.

> **Latest release:** [v1.0.3](https://github.com/chintan-27/smile-lab-attendance-app/releases/tag/v1.0.3)
> **All releases:** [Releases page](../../releases)

---

## Table of contents

* [Features](#features)
* [Downloads (macOS / Windows / Linux)](#downloads-macos--windows--linux)
* [Quick start (dev)](#quick-start-dev)
* [How it works](#how-it-works)
* [Configuration](#configuration)

  * [Google Sheets setup](#google-sheets-setup)
  * [Dropbox setup (optional)](#dropbox-setup-optional)
* [Daily summaries & catch-up](#daily-summaries--catch-up)
* [Admin UI cheatsheet](#admin-ui-cheatsheet)
* [Building locally](#building-locally)
* [Troubleshooting](#troubleshooting)
* [Project structure](#project-structure)
* [License](#license)

---

## Features

* **Simple sign-in / sign-out** with UFID and name
* **Student roster management** (add/remove, active flag)
* **Automated daily summary @ 10pm ET**

  * Computes hours per student for the day
  * If someone never logs out, session is capped at **5pm** (policy A) *or* you can enable auto sign-out at 5pm (policy B)
  * Saves a CSV like `data/reports/daily-YYYY-MM-DD.csv`
  * Also upserts a **Daily Summary** tab in Google Sheets: each date becomes a column with **hours** or **A** (absent)
* **Automated weekly CSV report**
* **Google Sheets sync**

  * Full sync or “today only”
  * Real-time single-row append on each sign-in/out when auto-sync is enabled
* **Dropbox backup & (optional) master-mode sync**
* **Robust logging** (view & clear from UI)
* **Crash-safe JSON storage** (`data/attendance.json`, `data/students.json`, `data/config.json`)
* **Works offline** and reconciles later

---

## Downloads (macOS / Windows / Linux)

Grab the latest installers from the **[Releases](../../releases)** page.

**macOS**

* Apple Silicon: `UF-Lab-Attendance-<version>-arm64.dmg` (or `-arm64-mac.zip`)
* *First run:* right-click the app → **Open** (bypasses Gatekeeper for unsigned apps)

**Windows**

* `UF Lab Attendance Setup <version>.exe`
  *SmartScreen may warn since the app isn’t code-signed → **More info → Run anyway**.*

**Linux**

* `UF-Lab-Attendance-<version>.AppImage`

  ```bash
  chmod +x UF-Lab-Attendance-<version>.AppImage
  ./UF-Lab-Attendance-<version>.AppImage
  ```

> Choose the file that matches your CPU (e.g., `arm64` on Apple Silicon).

---

## Quick start (dev)

```bash
# Clone
git clone https://github.com/chintan-27/smile-lab-attendance-app.git
cd smile-lab-attendance-app

# Install
npm install

# Run
npm start
```

---

## How it works

* **Main process:** `main.js` (Electron) wires up windows, IPC handlers, schedulers (cron), and services.
* **DataManager (`data.js`):** reads/writes JSON files in `data/`. Provides helpers for students, attendance, reports, and daily summary.
* **GoogleSheetsService:** handles service account auth and reads/writes to your spreadsheet.
* **DropboxService:** backups and (optional) master mode reconciliation.

**Schedulers**

* **2:00 AM ET** – daily Dropbox backup (if enabled)
* **10:00 PM ET** – daily attendance summary CSV + optional Google Sheets “Daily Summary” update
  Also does **catch-up** on startup if the app was closed during a scheduled time.

---

## Configuration

All configuration lives in `data/config.json`. It’s created with sensible defaults on first run.

```json
{
  "adminPassword": "<sha256 hash>",
  "labName": "University of Florida Lab",
  "emailSettings": {
    "enabled": false,
    "smtp": "",
    "port": 587,
    "secure": false,
    "email": "",
    "password": "",
    "recipientEmail": "",
    "recipientName": ""
  },
  "googleSheets": {
    "enabled": true,
    "spreadsheetId": "YOUR_SHEET_ID",
    "sheetName": "Attendance",
    "autoSync": false
  },
  "dropbox": {
    "enabled": false,
    "appKey": "",
    "appSecret": "",
    "refreshToken": "",
    "accessToken": "",
    "autoBackup": false,
    "autoReports": false,
    "masterMode": false,
    "syncIntervalMinutes": 10
  },
  "encryption": {
    "enabled": false,
    "algorithm": "AES-256"
  },
  "jobMeta": {
    "lastDailySummaryDate": "YYYY-MM-DD",
    "lastBackupAt": "ISO"
  }
}
```

### Google Sheets setup

1. **Create a Service Account** in Google Cloud → enable **Google Sheets API**.
2. Download the **JSON key** and save it as:

   ```
   data/google-credentials.json
   ```
3. In your target **Google Sheet**, share it with the service account’s **client_email** (Editor).
4. In the app’s **Admin → Google Sheets** section:

   * Set **Spreadsheet ID** (from the sheet URL)
   * Ensure a tab named **Attendance** exists (or change `sheetName`)
   * Click **Test Connection**
   * Optionally enable **Auto-Sync**

> The app will also create/update a **Daily Summary** sheet for per-day hours (or **A** for absent).

### Dropbox setup (optional)

* Fill **App Key**, **App Secret**, **Refresh Token** (OAuth) in the **Admin → Dropbox** section.
* Toggle **Auto Backup** if you want the 2 AM backup job.
* **Master Mode (optional):** treat Dropbox as the source of truth for `students.json` & `attendance.json`
  (local `config.json` is **not** synced).

---

## Daily summaries & catch-up

At **10:00 PM ET** every day the app:

1. Computes each student’s total hours for that calendar day.
2. **Policy (default A – cap only):**

   * If a student never logs out, their open session is **capped at 5:00 PM** *for the calculation only* (no mutation).
   * If they do log out after 5:00 PM, we **respect the real sign-out time**.
3. Saves `data/reports/daily-YYYY-MM-DD.csv`.
4. Upserts the **Daily Summary** sheet:

   * New column for the date (e.g., `02/11`)
   * Each row: **hours** (number) or **A** (absent)
   * If the hours came from a capped open session, the value is annotated like `5 [auto]`.

**Catch-up on startup:**
If the computer was off at 10 PM, on next launch the app looks for missed full days and generates summaries for each of them (and runs a catch-up Dropbox backup if >24h since last).

---

## Admin UI cheatsheet

* **Students:** add/remove, toggle active
* **Attendance:** view, delete records
* **Stats:** basic & enhanced (currently signed-in, today’s metrics)
* **Reports:** generate weekly CSV, email report (if email is configured)
* **Google Sheets:** save credentials, test connection, sync all / today / auto-sync toggle
* **Dropbox:** OAuth connect, test, default folders, list files, manual backup/upload
* **Logs:** view recent messages; clear logs

---

## Building locally

```bash
# Pack without publishing (produces unpacked builds)
npm run pack

# Build distributables for macOS, Windows, Linux (no publish)
npm run dist

# Build & publish to GitHub Releases (requires GH_TOKEN)
GH_TOKEN=<your_token> npm run dist
```

**Icons**

* macOS: `build/icon.icns`
* Windows: `build/icon.ico`
* Linux: `build/icons` (PNG set)

> This project is **not code-signed or notarized** by default; installers will still work but OS warnings may appear.

---

## Troubleshooting

**Google Sheets**

* *“Not configured”*: ensure `googleSheets.enabled=true`, `spreadsheetId`, `sheetName`, and `data/google-credentials.json` exist.
* *“No key or keyFile set.”*: malformed credentials file; ensure it contains `client_email` and `private_key` (with real newlines).
* *403 Permission*: share the sheet with the service account email (Editor).
* *Sheet/tab not found*: verify the `sheetName` matches the tab title exactly.

**Dropbox**

* OAuth errors: verify App Key/Secret/Refresh Token; click **Test Connection**.
* Master Mode: only `students.json` and `attendance.json` sync; `config.json` stays local.

**Daily summary**

* If you prefer **auto sign-out at 5 PM** (write a synthetic sign-out) instead of capping only, switch to policy B in `main.js`’s 10pm cron (commented in the code).

---

## Project structure

```
.
├── main.js                     # Electron main, IPC, schedulers
├── preload.js                  # Safe IPC surface for renderer
├── index.html / renderer.js    # UI & interactions
├── data.js                     # DataManager (students, attendance, reports)
├── googleSheetsService.js      # Service account auth + Sheets helpers
├── dropboxService.js           # Dropbox helpers
├── logger.js                   # Log store & filters
├── data/                       # Runtime data & config (created on first run)
│   ├── students.json
│   ├── attendance.json
│   ├── config.json
│   └── google-credentials.json  # <-- you provide this
├── build/                      # Icons & (optional) entitlements
└── package.json
```

---

## License

MIT — see [LICENSE](./LICENSE).
