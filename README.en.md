# WebSua — Cloud Reel

[![CI](https://github.com/oxisu/WebSua/actions/workflows/ci.yml/badge.svg)](https://github.com/oxisu/WebSua/actions/workflows/ci.yml)

**English** | [简体中文](./README.md)

> **WebSua** ("云刷") — Turn videos scattered across multiple WebDAV drives into
> one endless, swipeable stream.

- **Zero dependencies**: Front-end native ES Module + CSS, back-end Python **pure stdlib**. Just `python main.py`
- **Multi-source**: Each WebDAV is an independent source — scanned and filtered separately
- **Responsive**: Phone (bottom tab bar) / Tablet (icon sidebar) / Desktop (three-column + queue)
- **Dark / Light theme**: Follows system preference, manual toggle, no flash
- **TG cover art**: Auto-detects thumbnails next to Telegram-exported videos (per-source toggle)
- **Subtitles**: Auto-links `.srt` / `.vtt` with the same name in the same folder; front-end converts SRT → VTT. Toggle / font size / delay
- **Scan control**: Rate limiting, exponential backoff retries, pause / resume / stop, detailed logs
- **License**: [GNU AGPL-3.0](./LICENSE) — redistribution or network service must open-source under the same license

> **Currently only WebDAV scanning is supported.** For the design doc on "TB-scale cloud drive
> scanning via official API", see **[docs/design-pan123-api.md](./docs/design-pan123-api.md)** —
> that is a design proposal, not a shipped feature.

---

## Quick Start

```bash
python main.py
```

That's it. First run auto-creates `data/library.db` and opens the browser. **No pip install needed.**

```bash
python main.py --port 9000        # custom port (auto-increments if taken)
python main.py --browser          # auto-open browser (off by default)
python main.py --scan             # scan all sources immediately after start

# LAN access (phone / TV / other devices): must set a password, otherwise refuses to start
python main.py --host 0.0.0.0 --password YOUR_PASSWORD
```

### Try It Now: One-Command Demo (No Cloud Account Needed)

```bash
python demo.py
```

This single command does four things: starts a **fake WebDAV server** (content generated
on the fly) → launches WebSua with an **isolated demo data directory** `data-demo/`
(**never touches your `data/`**) → auto-creates two demo sources and completes scanning
→ opens the browser.

You can actually play and scrub (real Range requests), see covers, see subtitles, and
there is a full season of episodes to test "auto-play next". A bookmark and a watch
progress are pre-seeded so the UI looks "lived-in" on first open.

```bash
python demo.py --port 8780        # custom port (fake WebDAV defaults to 8897, auto-increments)
python demo.py --no-browser       # start server only, don't open browser
python demo.py --reset            # wipe demo data and start fresh (only affects data-demo/)
```

> `--reset` and `--data` have guardrails: **never** writes demo data to your real `data/`
> directory, and refuses to wipe `data/`. Demo data is a throwaway sandbox.

### Common WebDAV Endpoints

| Cloud Service | WebDAV URL |
| --- | --- |
| Nextcloud | `https://domain/remote.php/dav/files/USERNAME` |
| ownCloud | `https://domain/remote.php/webdav` |
| Synology DSM | `https://domain:5001/webdav` |
| Nutstore (坚果云) | `https://dav.jianguoyun.com/dav/` |
| alist | `http://domain:5244/dav` |

---

## Features

### Three Views

| View | Purpose |
| --- | --- |
| Video Feed | Full-screen vertical player, scroll/swipe to next, keyboard ↑↓ or k/p |
| Media Library | Grid browse (All / History / Favorites), cover art (TG cover first, then video frame), search / pagination |
| Sources | Manage WebDAV: add / edit / enable / delete, scan progress, logs, per-source TG cover toggle |

### Settings (gear icon, top bar)

| Setting | Default | Description |
| --- | --- | --- |
| Auto-play next | Off | Auto-advance on finish/error (endless scroll mode) |
| Resume last session | On | Restore last source filter, order, and position on open |
| Autoplay | On | Auto-play when scrolled into view |
| Player debug log | Off | Toggle in player "More" menu |
| Feed page size | 24 | Items loaded when scrolling to bottom in feed |
| Library page size | 48 | Items loaded when scrolling to bottom in library |

### Watch History

- "History" filter in library: sorted by most recently watched, with progress bar and "done / %" badge
- Click any history item → jump back to feed and **resume** from last position
- "Resume last session" (default on): auto-restores source filter, order, and current item on reopen
- Progress reported every 5s + `sendBeacon` on page unload

### TG Export Covers (Per-Source Toggle)

Telegram Desktop exports a thumbnail next to each video. Observed naming patterns:

```
1 (3).mp4 + 1 (3).mp4_thumb.jpg   ← TG primary rule (full video name + _thumb.jpg)
video.mp4 + video.jpg             ← same-name (other tools)
video.mp4 + video.mp4.jpg         ← original name + .jpg (other tools)
```

- Toggle "TG Export Cover" (`sources.tg_mode`) in source edit dialog — **per-source**
- When enabled, scanning auto-links matching images as video covers (`/api/poster/{id}`)
- **Matched thumbnails are removed from the media library** — they are accessories to the video, not standalone media. Normal photos (`photo_xxx.jpg`) won't match video names and are unaffected
- Cards show a "TG Cover" badge; library/queue prefer covers over frame captures
- Re-scan the source after toggling for changes to take effect

### Subtitles (Same-Name `.srt` / `.vtt` in Same Folder)

Scanning links same-name subtitles in the same folder to the video (**subtitle files don't appear in the media library** — they are accessories):

```
My Movie.mp4 + My Movie.srt        ← primary rule (same name, different extension)
My Movie.mp4 + My Movie.mp4.srt    ← variant (full video name + .srt)
```

- Backend returns subtitles as-is; **SRT → VTT conversion happens in the front-end** (keeps backend zero-dependency)
- Player control bar has a "Subtitles" toggle; "More → Subtitle Settings" adjusts **font size** (S/M/L) and **delay** (±0.5s)
- Subtitles shown by default when available; button hidden when none, `/api/subtitle/{id}` returns 404
- **No `.ass` / `.ssa` support**: high parsing cost for styles/positioning — ignored, not indexed
- Subtitle links refresh on each scan

### Play Queue / Next Episode

The "Play Queue" panel on the right turns "continuous play" into an explicit queue:

- **Natural-order generation**: Playing any video auto-builds a queue of all videos in its folder sorted by **natural order** (`Ep1, Ep2, … Ep10, Ep11` — lexicographic sort puts 10 before 2, breaking binge-watching), starting from the current episode. The random feed is for "discovery"; the queue is for "continuity"
- **Drag to reorder**: Grab the handle on the left of any row; current playing item stays fixed
- **Loop modes**: Off (stop after last) / List repeat / Single repeat — button cycles through
- **Shuffle**: Only shuffles **play order** (current item always pinned to top); visible list stays in folder order
- **Persisted**: Queue is stored server-side (IDs only, resolved on read; deleted files / disabled sources auto-pruned). Survives refresh, restart, and browser switch
- **Clear = disable**: Clearing the queue also disables auto-generation to avoid it rebuilding on next skip. Can re-enable from the empty state via "Enable for current video"
- Previous / next navigation, keyboard ↑↓/k/p, auto-play, bad-item skip — all follow the queue
- Queue navigation switches the feed to that folder's natural-order list — **random order is not reproducible** (SQLite `RANDOM()` differs each call), so it can't be used as a queue anchor

### Directory Exclusion

"Exclude directories" input in source edit dialog (`sources.exclude_dirs`):

- Comma-separated **directory names** (both Chinese and English commas), e.g. `scratch,temp`
- Matching directory subtrees are skipped during scanning (case-insensitive)
- Scan start log records the exclusion list for verification

### Incremental Scan / Resume

- **Incremental is the default for re-scans**: Clicking "Scan" on an already-scanned source auto-uses incremental mode (first scan is always full). Signature = `size + mtime + linked cover/subtitle path`; unchanged items are **not written to DB and `indexed_at` is not refreshed** — otherwise every re-scan would mark everything as "just added", breaking the "Newest" sort
- Completion summary shows **Added / Updated / Unchanged / Removed** in a toast. Use "More → Full Re-scan" to start over
- **Cancel preserves progress**: Stopping a scan keeps discovered files in the staging table and the directory traversal stack persisted. The card shows "Resume Scan + Discard". Resume picks up from the checkpoint, **not from the root**. Refresh or restart won't lose it (auto-resume on restart if "auto-scan" is enabled)
- Checkpoints auto-invalidate when **root / excluded dirs / depth** change — stale state is more dangerous than no state
- Incremental **doesn't reduce traversal cost**: PROPFIND still fires (can't detect new files without listing). It saves DB write amplification and "Newest" pollution. The "hours per scan" problem needs the official API approach (see [docs/design-pan123-api.md](./docs/design-pan123-api.md))

### Failed Directory Re-scan / Scan Diff Report

When a directory listing fails during scanning (timeout, permission error, etc.), **the entire subtree's files vanish**. These failures are never silently discarded:

- **Failed dirs persisted**: Atomically refreshed after each scan; card shows a red badge "⚠ N dirs failed" (hover for paths) instead of hiding in logs
- **Re-scan only failed dirs**: Click "Re-scan Failed Dirs" on the card for targeted re-scan. This is a **partial commit** — only adds/updates entries under those dirs; other dirs' media is **never deleted** (otherwise "partial scan" would be misread as "everything else is gone")
- **Scan diff report**: Each completed scan writes a diff record (added / updated / removed / unchanged) **including specific paths deleted from the remote** — traceable when "when did this file disappear?" comes up
- After fixing and re-scanning, badges clear automatically; still-failing dirs stay in the list for retry

### LAN Access Password (Auth Gate)

Default binding is `127.0.0.1` — **only accessible from the local machine, no password needed**. Once you use `--host 0.0.0.0` to expose on the LAN, anyone on the same Wi-Fi can open your media library. So:

- **Non-localhost binding requires a password**: Starting with `--host 0.0.0.0` and no password **refuses to start**, rather than warning and running naked
  ```bash
  python main.py --host 0.0.0.0 --password YOUR_PASSWORD
  # or via env: WEBSUA_ACCESS_PASSWORD=xxx python main.py --host 0.0.0.0
  ```
- **Unified auth**: All `/api/*` endpoints are protected, **including media streams / covers / subtitles** (only login, `/api/auth/status`, and health check are exempt). Static assets serve normally — otherwise the login page itself can't render
- **Three credential methods**: Browser uses HttpOnly Cookie (`<video>` / `<img>` requests carry credentials automatically — no token in media URLs); scripts use `Authorization: Bearer <token>`; external players (VLC etc.) use `?token=<token>` (returned in login response)
- **Password never stored in plaintext**: pbkdf2-hmac-sha256 + random salt, digest only. A copied DB can't reveal the password. **Changing the password revokes all previously issued tokens** (old tokens were signed with the old password)
- **Login rate limiting**: 5 consecutive failures = 60s lockout, blocking LAN brute-force
- **Single-user gate only** — no multi-user system. Enough for personal / family use

### Config Import / Export / Backup

Settings has "Data Backup": bundles **source configs, front-end settings, favorites, watch progress** into a JSON file for one-click restore after migration or reinstall. Born from the "tests accidentally wiped user data" incident — **recoverability must be designed in**.

- **Favorites/progress don't use `media_id`**: `media_id` is local auto-increment and won't match across instances. Backup uses stable keys `(base_url, root_path) + remote_path`, resolved to local `media_id` on import
- **Unscanned media is skipped and counted**: On a new machine, import config first, scan, then import again to backfill favorites/progress (never fabricated, never silently dropped — the summary tells you exactly how many were skipped)
- **Passwords redacted by default**: Only `has_password` (boolean) is recorded. Check "Include WebDAV passwords on export" to write plaintext — treat that file as a credential
- **Safe reverse operation**: Import is **merge semantics** — never deletes existing data; **never overwrites an existing password with empty**; repeated imports are idempotent (sources upsert by URL+root, favorites de-duplicate)
- Pre-import validation: version too high, non-WebSua backup, wrong field types → all 400 with clear reasons

### Scan Control

- Clicking "Scan" **connectivity-probes first** — wrong password / URL fails immediately, no wasted scan
- During scan: **pause / resume / stop** (stop discards DB writes); pause UI toggles instantly (optimistic update, ~100ms) without waiting for backend
- Progress reflects directories traversed (total unknown, capped at 92%); "Current: /path" shows real-time directory being listed
- **Granular logs**: Every 25 directories / 500 files logs "Progress: X dirs traversed · Y files found" — no more single-line "scan started" black box
- **Rate limiting**: Minimum 0.25s between PROPFIND calls (configurable) to avoid triggering cloud rate limits
- **Retries**: 429 / 5xx / **connection errors** (TLS handshake timeout, connection refused, etc.) with exponential backoff 3× (0.5s→1s→2s, 429 waits extra 5s). Stream opening also retries (short 15s timeout for fast fail-fast-retry)
- **Large directory protection**: HTTP timeout default 120s (TB-scale drives have slow PROPFIND responses). Directory listing failures are **never silent** — error in log, completion summary shows "⚠ N dirs failed and skipped", card shows yellow banner recommending re-scan
- **Logs**: `data/scan.log` (auto-rotates at 512KB), card "Logs" button or "More → View Logs". Playback failures are also logged (source / filename / remote path / status code)

### Player

- Desktop landscape video fills viewport; portrait video auto-centers (object-fit: contain)
- Three watchdogs: 25s load timeout / 20s playback stall / 12s buffer-without-frame auto-reset (max 3 retries)
- Dual-endpoint fallback: `/api/stream/{id}` failure auto-switches to `/api/proxy/{id}`
- Keyboard: Space/K play-pause, ←→ seek ±10s, 0-9 jump to percentage, M mute, F fullscreen, L loop, R rotate
- Double-tap left/right to seek, PiP, screenshot (canvas → PNG), copy direct link, speed 0.25x–3x

---

## Project Structure

```
WebSua/
├── main.py                 # Entry point
├── demo.py                 # One-command demo: fake WebDAV + isolated data dir
├── backend/
│   ├── config.py           # Extensions/MIME, scan params, rate limit/retry config
│   ├── db.py               # SQLite (single connection + RLock), light migrations
│   ├── webdav.py           # WebDAV client: PROPFIND (rate limit + retry), Range streaming
│   ├── pan123.py           # Planned: 123 Open API client (token refresh + file/list pagination)
│   ├── scanner.py          # Scan tasks: thread + pause/cancel + TG cover matching + logs
│   ├── stream.py           # HTTP Range parsing and stream forwarding
│   └── server.py           # HTTP server: 24 REST routes + static + media streaming
├── frontend/
│   ├── index.html          # Inline theme pre-execution script (anti-flash)
│   ├── css/
│   │   ├── theme.css       # Design tokens: dark/light theme, breakpoints, spacing, transitions
│   │   ├── player.css      # Player cvp-* classes
│   │   └── app.css         # Layout, 3 breakpoints, components
│   └── js/
│       ├── app.js          # Entry: routing, sidebar, queue panel, settings modal
│       ├── feed.js         # Vertical video feed (windowed mount + IntersectionObserver + queue nav)
│       ├── queue.js        # Play queue: natural-order gen / drag / loop / shuffle / persistence
│       ├── grid.js         # Media grid (pagination + thumbnails)
│       ├── sources.js      # Source management (state machine + fine-grained DOM updates)
│       ├── video-player.js # Player (watchdogs + endpoint fallback + more menu)
│       ├── thumbs.js       # Video frame capture (concurrent limit 3 + failure cache)
│       ├── progress.js     # Watch progress (throttled report + sendBeacon fallback)
│       ├── settings.js     # Front-end settings (localStorage + pub/sub)
│       └── utils.js        # Fetch, formatting, toast, theme
├── tests/
│   ├── fake_dav.py         # Fake WebDAV (good/auth/norange modes, 24 batch dirs + 12-episode series)
│   ├── run_all.py          # One-command regression: auto-start, mode switch, port cleanup
│   ├── test_compat.py      # Repo constraints 26 items (3.9 syntax / lazy annotations / zero deps / CI drift)
│   ├── browser-env.js      # Cross-platform Chromium detection (Win/Linux/macOS + PLAYWRIGHT_CHROME override)
│   ├── test_e2e.py         # End-to-end 36 items
│   ├── test_norange.py     # Local Range clipping when server ignores Range 17 items
│   ├── test_edge.py        # Auth / remote deletion / password non-leak 14 items
│   ├── test_subtitles.py   # Subtitle association and retrieval
│   ├── test_queue.py       # Play queue: natural order + persistence API 23 items
│   ├── test_incremental.py # Incremental scan & resume 43 items
│   ├── test_failed_dirs.py # Failed dir re-scan + diff report 24 items
│   ├── test_failed_dirs_ui.js # Failed dir UI 9 items (self-contained)
│   ├── test_access.py       # LAN auth gate 32 items
│   ├── test_access_ui.js    # Auth login UI 9 items (self-contained)
│   ├── test_backup.py       # Config import/export 27 items
│   ├── test_backup_ui.js    # Backup UI 9 items (self-contained)
│   ├── test_demo.py         # Demo regression 30 items
│   ├── test_release.py      # Release assets 38 items
│   ├── test_scan_ui.js    # Scan panel UI 14 items
│   ├── test_browser.js     # Browser 60 items (3 breakpoints × dark/light × layout)
│   ├── test_new_features.js# New features 8 items
│   ├── test_queue_ui.js    # Play queue e2e 24 items
│   ├── test_ui_polish.js   # UI polish 19 items
│   ├── audit_ui.js         # Full-page screenshot audit (3 breakpoints × 12 scenarios)
│   ├── gen_media.js        # Generate real webm test media via MediaRecorder
│   └── gen_posters.js      # Generate same-name JPG cover art
├── .github/workflows/
│   ├── ci.yml              # CI: 3 OS × Python 3.9/3.11/3.13 + browser suite
│   └── release.yml         # Push v* tag: regression → package → create Release
├── scripts/
│   ├── package.py          # Reproducible zip (fixed timestamp + sorted entries + SHA256)
│   └── changelog_section.py# Extract version section from CHANGELOG for Release notes
├── CHANGELOG.md            # Changelog (single source of truth for Release notes)
├── package.json            # Dev-only dependencies (Playwright); WebSua itself doesn't need Node
└── data/
    ├── library.db          # SQLite (auto-created)
    └── scan.log            # Scan log
```

---

## API Overview

> With access password enabled, **all `/api/*` require auth** (Cookie / `Authorization: Bearer` / `?token=`), including media streams and covers. Only `/api/auth/login`, `/api/auth/status`, and `/api/health` are exempt.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health`, `/api/stats` | Health check / global stats |
| GET | `/api/auth/status` | Auth gate status (`required` / `authed`), **no auth needed** |
| POST | `/api/auth/login` | Exchange password for token (HttpOnly Cookie + token in response), **no auth needed** |
| POST | `/api/auth/logout` | Revoke current token and clear Cookie |
| POST | `/api/auth/password` | Set / change / disable access password (auth required if gate active; cannot disable on LAN binding) |
| GET | `/api/backup/export` | Export config & watch data (JSON download; `?passwords=1` includes WebDAV passwords) |
| POST | `/api/backup/import` | Import backup (merge semantics, returns restored/skipped summary) |
| GET/POST | `/api/sources` | List (with category counts, total size) / Create |
| PUT/DELETE | `/api/sources/{id}` | Update (empty password = keep) / Delete (cascades index) |
| POST | `/api/sources/{id}/probe` | Connectivity test, no DB write |
| POST | `/api/sources/{id}/scan` | Trigger scan (body: `mode=full\|incremental`, `resume=true`) |
| POST | `/api/sources/{id}/scan/pause·resume·cancel` | Scan control (cancel preserves checkpoint for resume) |
| GET/DELETE | `/api/sources/{id}/scan-state` | Query / discard saved scan checkpoint |
| GET | `/api/tasks`, `/api/tasks/{id}` | Task list (one per source) / detail with logs |
| GET | `/api/scan-log` | Tail of scan.log |
| GET | `/api/media` | Paginated list (sources/kinds/folder/q/order/fav/limit/offset; `order=natural` for natural sort) |
| GET | `/api/history` | Watch history (watched media, newest first, sources/limit/offset) |
| GET | `/api/media/{id}` | Detail (player info panel) |
| POST | `/api/media/{id}/fav` | Toggle favorite |
| GET/POST/DELETE | `/api/queue` | Play queue persistence (stores IDs, resolves on read) |
| GET/POST | `/api/progress`, `/api/progress-batch` | Watch progress (batch for sendBeacon) |
| GET | `/api/stream/{id}` | Media stream (Range, `?dl=1` to download) |
| GET | `/api/proxy/{id}` | Fallback endpoint (no Range, full body) |
| GET | `/api/poster/{id}` | TG same-name cover (404 if none) |
| GET/POST | `/api/settings` | Server settings (reserved) |

---

# Lessons Learned & Design Docs

The most valuable part of this project isn't the feature list — it's the **pitfalls we fell into**. They're documented separately:

- **[docs/lessons.md](./docs/lessons.md)** *(Chinese)* — Pure stdlib decision, SQLite concurrency, Range stream forwarding, scan task state machine & race conditions, CSS/front-end pitfalls, test infrastructure, 123 cloud drive war stories… Every entry is a real incident, not imagined best practice.
- **[docs/design-pan123-api.md](./docs/design-pan123-api.md)** *(Chinese)* — Design proposal for "TB-scale cloud drive scanning via official API", risk assessment, and verification checklist. Design doc, not shipped feature.
- **[docs/ROADMAP.md](./docs/ROADMAP.md)** *(Chinese)* — Roadmap and trade-off records.
- **[CHANGELOG.md](./CHANGELOG.md)** — What changed in each version.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `WEBSUA_DATA` | `./data` | Data directory |
| `WEBSUA_SCAN_DEPTH` | `8` | Max scan directory depth |
| `WEBSUA_SCAN_RATE` | `0.25` | Min PROPFIND interval (seconds), rate-limit protection; VIP cloud can lower to 0.1 |
| `WEBSUA_SCAN_RETRIES` | `3` | Retry count for rate limit / server error / connection error |
| `WEBSUA_SCAN_BACKOFF` | `1.0` | Backoff base (exponential: 0.5s, 1s, 2s…) |
| `WEBSUA_SCAN_429_WAIT` | `5.0` | Extra wait seconds on 429 |
| `WEBSUA_SCAN_HTTP_TIMEOUT` | `120` | Scan HTTP timeout (seconds); large directories respond slowly — increase to reduce skips |
| `WEBSUA_SCAN_LOG_EVERY_DIRS` | `25` | Progress log every N directories |
| `WEBSUA_SCAN_LOG_EVERY_FILES` | `500` | Progress log every N files |
| `WEBSUA_VERBOSE` | — | Print HTTP access logs |

**Planned (not implemented yet)**: `WEBSUA_API_PROTOCOL`, `PAN123_CLIENT_ID`, `PAN123_CLIENT_SECRET`, `PAN123_TOKEN_TTL`, `PAN123_LINK_TTL`, `WEBSUA_API_RATE`. **Do not add to `.env` before implemented** — they won't take effect.

## FAQ

**Q: Scanned file count doesn't match what my cloud drive shows?** Check the scan summary/log for "⚠ N dirs failed and skipped" — large directory timeouts skip entire subtrees; re-scan failed dirs to fill in. If no failures, check excluded dirs and whether depth exceeded 8 (`WEBSUA_SCAN_DEPTH`). Excluding TG export subfolders also reduces noise.

**Q: Scan progress seems stuck?** Large directories (10k+ files) take tens of seconds for PROPFIND to respond. With the 120s timeout, most will eventually complete. If the log shows "directory listing failed", that dir was skipped (can re-scan).

**Q: Video won't play?** Player "More → Debug Log" shows the reason (auth failure / file not found / format unsupported). The "playback failed" lines in `data/scan.log` include remote path and status code — useful for bug reports. 123 cloud drive has intermittent connection jitter; the built-in retry chain (stream retry → player watchdog → proxy fallback) handles most transient failures.

**Q: TG thumbnails still showing in the media library?** Make sure the source has "TG Export Cover" enabled and **re-scan** — matching happens at scan time; existing scans won't retroactively link. Matched thumbnails are removed from the library.

**Q: TB-scale drive takes hours to scan — permanent fix?** The real fix is **official API scanning + WebDAV playback** (scan via `file/list` pagination, playback via existing Range chain). See **[docs/design-pan123-api.md](./docs/design-pan123-api.md)** for design and risks. Until then: tune parameters, exclude directories, split large trees into multiple sources. **Not yet implemented** — current version is WebDAV-only scanning.

**Q: Self-signed certificates?** Not supported yet. For LAN, use `http://` URLs (internal hostnames auto-get http).

**Q: Want precise thumbnails?** Current front-end frame capture is at 1 second. TG cover mode uses the exported image directly. FFmpeg-level precision would require backend dependencies — intentionally avoided to keep zero dependencies.

## Testing

```bash
python tests/run_all.py            # One command: isolated server → 13 backend suites → auto cleanup
python tests/run_all.py --env-only # Start isolated test env only (for debugging individual tests)
python tests/test_compat.py        # Repo constraints (3.9 syntax / zero deps / CI config drift)
python tests/test_release.py       # Release assets (reproducible zip / checksum / CHANGELOG extraction)
python tests/test_demo.py          # Demo regression (self-contained, no isolated env needed)
node tests/test_browser.js         # Browser 60 items (needs isolated env running)
node tests/test_ui_polish.js
node tests/audit_ui.js             # Full-page screenshot audit
```

**CI** (`.github/workflows/ci.yml`): Ubuntu / Windows / macOS × Python 3.9 / 3.11 / 3.13 runs full backend regression, plus a Chromium job for three self-contained UI suites. Playwright is a **dev dependency** in `package.json` `devDependencies` — running WebSua itself doesn't need Node.

**Tests are fully isolated from user data**: all tests run on **port 8792** (fake WebDAV on 8898), data directory is `data-test/` — destructive operations like "clear sources" or "delete remote files" only affect the isolated instance, **never your production 8771 service or `data/` directory**.

---

## Releases & Versioning

Version cadence is **one feature, one commit, one tag**: each feature gets a patch/minor version, four commits (backend / front-end / tests / docs) then an annotated tag pointing to the last commit. History in [CHANGELOG.md](./CHANGELOG.md).

```bash
python scripts/package.py                 # → dist/WebSua-<version>.zip + .zip.sha256
python scripts/changelog_section.py v1.12.0   # Extract version notes (for Release body)
```

Two deliberate packaging choices:

- **Reproducible**: Entries sorted by path + fixed timestamp → same source produces identical SHA256 every time. Otherwise "checksum" is meaningless.
- **No local artifacts**: `data/`, `data-test/`, `*.db`, `*.log`, `__pycache__`, `node_modules` all excluded. Shipping someone's media library index in a release is an incident, not a feature.

Pushing a `v*` tag triggers `.github/workflows/release.yml`: full regression first (**no pass, no release**) → package → extract current version section from `CHANGELOG.md` as Release notes → upload zip + `.sha256`.

Unzip and run: `python main.py` works immediately, `python demo.py` demos out of the box. The `tests/` directory is included — `demo.py` depends on its fake WebDAV and sample media.
