# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Dijital Kurye "Dağıtım Günü": a PWA that shows the earliest delivery day for a neighbourhood (mahalle) or a full address. The UI, comments, commit messages and API field names are in Turkish; keep new code consistent with that.

There is **no build step, no package.json, no test suite and no linter**. The front end is plain HTML with inline `<style>`/`<script>`. Each Worker is a single `worker.js` ES module.

## Layout and how the pieces connect

- `index.html`: the public lookup page. It calls two Workers whose URLs are hard-coded near the top of its script: `DATA_API` (`dagitimveri.egemenduman.workers.dev`) and `OPS_API` (`dagitimuyari.egemenduman.workers.dev`).
- `admin.html`: the admin panel (`API` constant points at `dagitimveri`). It reads the Excel/CSV in the browser with SheetJS (loaded from a CDN), then uploads the rows in three steps: `/admin/start` → repeated `/admin/chunk` calls (200 rows each; the worker rejects more than 250) → `/admin/finish`. Rows go into the staging table `dagitim_yeni`. `finish` replaces `dagitim` with them in one batch, keeping the last row for each il/ilçe/mahalle, and updates `veri_bilgisi`. All admin calls send the `X-Admin-Password` header.
- `worker/dagitimveri/`: the data API (Worker + D1, binding `DB`). README.md has the endpoint table.
  - `ensureSchema()` runs lazily on some routes. It creates `dagitim_yeni`, `admin_deneme` and `oneri_limit`, adds and backfills the `arama` column on `dagitim`, and adds its index. The core tables `dagitim`, `veri_bilgisi` and `oneriler` are assumed to exist already; no code creates them.
  - Accent-insensitive search: `trKey()` (JS) and `trKeySql()`/`ARAMA_EXPR` (SQL, because SQLite's `lower()` only handles ASCII) must fold Turkish characters the same way. If you change one, change the other. After a change to `ARAMA_EXPR`, the existing `arama` values need re-backfilling.
  - `/api/adres-gun` proxies Optymus (`work-days-by-full-address`). The worker fetches and refreshes the OAuth password-grant token from secrets, caches it, and caches results for `OPTYMUS_CACHE_TTL`. Optymus `days` use 0=Sunday…6=Saturday. A non-empty `errors` array comes back from Optymus as HTTP 200, and the worker turns it into `422 {adresHatasi:true}`. `extractDays()` parses the response defensively, accepting several payload shapes. The env vars are documented in the header comment of `worker.js`. API details are in `docs/optymus-work-days.postman_collection.json` and README.md.
  - When nothing matches, `/api/ara` falls back to `reverseAddressMatch()`, which finds known mahalle names inside a free-text address using an in-memory `geoCache` that `finish` resets.
- `worker/dagitimuyari/`: has no bindings. `/weather?il=&ilce=` scrapes MGM forecast data. The default route returns operational alerts collected from Google News RSS (only `.gov.tr` sources are kept) and the KGM closed-roads page.
- `service-worker.js`: caches only the same-origin app shell. It never caches the API, other origins or `admin.html`. **Bump `CACHE` (`dagitim-gunu-vN`)** when shell files change or the list of shell files changes.

## Day-index conventions (easy to get wrong)

- D1 table and admin upload: 7 columns ordered Monday…Sunday (`DAY_KEYS`: pazartesi … pazar), values 0/1.
- Front end: `nextOpen(days, iso)` takes a Monday-first array of 7 entries (`idx = (getDay()+6)%7`). Dates are computed in **local time** (`localISODate`) so Turkey's UTC+3 offset doesn't show yesterday's date just after midnight.
- Live (Optymus) results can be reserved from **tomorrow** at the earliest (`liveStart`). Table results can start today.
- If the live lookup fails, the front end falls back to the table record (`withLive`) and shows a note.

## Deploy / run

```bash
cd worker/dagitimveri && npx wrangler deploy     # same for worker/dagitimuyari
npx wrangler dev                                  # local run of a worker
```

Secrets are set with `wrangler secret put`: `ADMIN_PASSWORD`, `OPTYMUS_USERNAME`, `OPTYMUS_PASSWORD` (or `OPTYMUS_TOKEN`). `ALLOWED_ORIGINS` is optional and limits CORS on the admin endpoints.

To preview the front end, serve the repo root statically (e.g. `python3 -m http.server`). The page always calls the deployed Workers. The service worker registers only over HTTPS.

## Fonts / branding

The brand font is Biennale, which is licensed and not in the repo. The `@font-face` rules in both HTML files use only `local()` and fall back to Plus Jakarta Sans. Don't add `url(fonts/...)` unless the font files are actually added (see `fonts/README.md`); otherwise browsers log 404s.
