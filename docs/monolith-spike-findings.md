# monolith — spike findings (measured)

**Date:** 2026-08-12
**Binary:** `monolith 2.10.1`, installed via `winget install --id Y2Z.Monolith`
**Actual path:** `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Y2Z.Monolith_Microsoft.Winget.Source_8wekyb3d8bbwe\monolith.exe`

Everything below is measured on this machine, not inferred. Reproduce commands included.

---

## 1. Install: do NOT use `cargo install`

`cargo install monolith` **fails** on this machine (exit 101). monolith v2.10.1 pulls
`openssl-sys`, which vendor-builds OpenSSL from source; that requires a native Windows
perl, and the `perl` on PATH is Git Bash's MSYS perl (`/usr/share/perl5/core_perl/...`),
which cannot run OpenSSL's MSVC `Configure`:

```
warning: openssl-sys@0.9.117: configuring OpenSSL build: 'perl' reported failure with exit code: 2
error: failed to run custom build command for `openssl-sys v0.9.117`
```

**Use winget.** It downloads the prebuilt `monolith.exe` from the GitHub release — no
compilation, no OpenSSL, no perl:

```bash
winget install --id Y2Z.Monolith --exact --silent --accept-package-agreements
```

The `WinGet\Links\monolith.exe` shim only resolves in a *fresh* shell. Call the real
binary under `WinGet\Packages\...` by absolute path instead of relying on PATH.

---

## 2. `-o` panics on any absolute path containing `~`

```
thread 'main' panicked at src\main.rs:291:18:
could not prepare output: Os { code: 3, kind: NotFound, message: "The system cannot find the path specified." }
```

Triggered by `C:\Users\ETERNA~1\...` — the 8.3 short name for `Eternalgy`. monolith
does naive tilde expansion on the output path, so the parent resolves to nothing.

| form | result |
|---|---|
| `-o "C:\Users\ETERNA~1\...\a.html"` | **panic** |
| `-o b.html` with cwd set | OK |
| `-o -` (stdout) | OK |

**Integration rule: always use `-o -` and let Node write the file.** Recon controls the
destination path, and this is also what makes CSP post-processing (§4) free.

---

## 3. `-b` works, and images + fonts are 99.5% of the weight

Input: a real page's raw HTML saved locally (6,641 bytes), then re-bound to its origin
with `-b https://www.iana.org/help/example-domains`.

Relative URL resolution is correct — **0 leftover relative `src`/`href`**, all assets
resolved against the base and inlined.

| flags | bytes |
|---|---|
| full baseline | 26,093,554 |
| `-j` | 26,007,522 |
| **`-j -i -F`** | **125,972** |
| `-j -i -F -v -a -M` | 125,892 |
| `-j -i -F -v -a -M -I` | 125,941 |

Dropping images (`-i`) and fonts (`-F`) is a **207× reduction — 26 MB → 126 KB** — with
CSS and layout fully intact. `-j` is worth ~86 KB, i.e. it is a **safety** flag, not a
size flag.

At ~126 KB/route, a 13-route scan is ~1.6 MB total, which makes storing every scan and
diffing them for drift practical. At 26 MB/route it would be ~340 MB and it would not be.

---

## 4. monolith injects `script-src 'none'` even WITHOUT `-I`

This is the one that would have failed silently.

```
-j -i -F      →  <meta http-equiv="Content-Security-Policy"
                  content="font-src 'none'; script-src 'none'; img-src data:;">

-j -i -F -I   →  <meta http-equiv="Content-Security-Policy"
                  content="default-src 'unsafe-eval' 'unsafe-inline' data:;
                           font-src 'none'; script-src 'none'; img-src data:;">
```

`-j` alone emits `script-src 'none'`. **Any overlay JavaScript injected into a monolith
snapshot will not execute** — no error, no console warning, just a dead page. Anyone
building the annotation overlay would blame their own code.

`-I` adds `default-src ... data:`, i.e. true network isolation, but does not change
`script-src`.

**Required post-process** (free, since we already capture stdout per §2): rewrite the
CSP meta to keep the page inert while admitting only recon's overlay —

```
default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; script-src 'nonce-<random>'
```

> **Correction, 2026-08-12 — `style-src` needs `data:`.** This section originally specified
> `style-src 'unsafe-inline'`. That is wrong, and wrong silently. monolith does **not**
> inline CSS as `<style>`: §6's "inlined CSS payloads" arrive as
> `<link rel="stylesheet" href="data:text/css;charset=UTF-8;base64,…">` — measured on the
> captured payments snapshot, **2 stylesheet links, 0 `<style>` blocks**. `'unsafe-inline'`
> does not cover a `data:` URL, so both stylesheets are blocked and the snapshot renders
> completely unstyled, with no error and no console warning. Caught only by reading a
> written file; every byte count and flag in this document still checked out.

Page JS is already gone (`-j` stripped it); the page still cannot reach the network;
recon's overlay runs.

---

## 5. Settled flag set for recon

```
-o -  -b <route URL>  -e  -j  -i  -F  -v  -a  -M
```

- `-o -` — stdout, avoids the `~` panic (§2)
- `-b` — resolve relative assets against the live origin (§3)
- `-e` — ignore network errors, so one 401 asset does not fail the capture
- `-j -i -F -v -a` — inert and small (§3, §4)
- `-M` — no timestamp/URL comment, so snapshots of the same route diff cleanly

Then Node rewrites the CSP meta per §4 before writing the file.

---

## 6. Authenticated capture — VERIFIED against admin.atap.solar/payments

Live route captured through patchright on the `agent` profile (non-headless, §9), then
run through monolith with the §5 flag set.

**Structural fidelity is exact:**

| | live DOM | capture |
|---|---|---|
| bytes | 90,354 | 188,701 |
| `<table>` | 1 | 1 |
| `<tr>` | 17 | 17 |
| `<th>` | 7 | 7 |
| `<td>` | 96 | 96 |
| `<button>` | 46 | 46 |

Inlined CSS payloads: 207 bytes + **124,411 bytes** — the real stylesheet came through
complete (live page reported 2 stylesheet links, 1195 rules).

**`-C` is NOT needed for this site.** Capture with and without the cookie jar was
byte-identical (188,701 both). admin.atap.solar serves its CSS unauthenticated. Keep
`-C` in reserve for sites that gate static assets; do not wire it in by default.

**~2x expansion, not 200x.** 90 KB of DOM → 188 KB captured. Thirteen routes ≈ 2.5 MB.

**The 46 buttons are the whole argument for a visual planner.** §6 of the buildplan
records that the five payment-state tabs are plain `<button>`s indistinguishable from
`Delete Submission` by role or structure. The measured count is 46. Asking a human to
pick five out of a flat list of 46 is a different task from asking them to point at a
tab strip on a rendered page.

---

## 7. The `-C` cookie export is a live hazard — domain-filter it

Building the jar with a bare `ctx.cookies()` on the `agent` profile exported **29
cookies across 9 domains**:

```
.facebook.com   .web.whatsapp.com   .messenger.com   .github.com
www.google.com  .yandex.ru          .sannysoft.com   .atap.solar
```

Exactly **one** of those belongs to the target site. The other 28 are the real logged-in
sessions that buildplan §6 refuses to put at risk for "a recon convenience" — written to
a plaintext file, inside the git repo.

**Rule: if a cookie jar is ever exported, filter to the target registrable domain before
writing, and write it outside the repo.** Since §6 shows `-C` is not needed for this
site, the safest default is not to export one at all.

Captured snapshot for reference (vault, not repo):
`E:\eter-browser\tools\admin.atap.solar\recon\snapshots\payments.html`
