# Site Beam — UI / Integration Improvement Wishlist

Non-urgent ideas and deeper Local-integration opportunities. Nothing here is
committed work; it's a parking lot so findings don't get lost.

---

## 1. Set the default web server via `defaultSiteServices` (future improvement)

**What:** Local exposes a `defaultSiteServices` filter that receives the computed
default service list (PHP / web server / DB, each tagged with a `SiteServiceRole`)
for a *newly created* site.

- Renderer: `applyFilters("defaultSiteServices", services, env)` — seen in
  `renderer/_browserWindows/app/app.js` (Local 10.1.1).
- Registerable from our `main` process via `LocalMain.HooksMain.addFilter('defaultSiteServices', …)`.

**Why it's interesting:** it's the clean, UI-less lever to influence which web
server new sites default to. Our current Apache-preservation fix lives in the
**import** path (`src/lib/importer.js` — promote to a custom environment when the
source ran a non-nginx web server). `defaultSiteServices` is orthogonal: it would
change Local's *own* default for sites created outside Site Beam. Only relevant if
we ever want to steer defaults globally; **not** a replacement for the import fix.

**Caveat:** it changes the default for *all* new sites, not just Site Beam imports —
so scope it carefully (probably not something we want on unconditionally).

---

## 2. Re-home the UI: Preferences pane + Add-a-Site receive flow

All findings confirmed against the installed Local **10.1.1+6939**
(`/Applications/Local.app`, extracted `app.asar`), since `@getflywheel/local` is a
host-provided peer and isn't vendored in this repo.

### 2a. Target architecture (decided — revisit before building)

Move each concern to its proper home. Guiding rule:
**send from the site (Tools), receive from Add-a-Site, configure in Preferences.**

| Concern | New home | Notes |
|---|---|---|
| Shared code (Bonjour channel) + display name | **Preferences › Site Beam** | Global config; never really per-site |
| Receive over LAN | **Add a Site** → "from LAN" | Pick a machine → list its sites → pull. One entry, not N per-machine buttons — discovery is async, so a single entry with a scanning state scales and avoids re-scanning on every open |
| Receive over WAN (croc) | **Add a Site** → "from transfer code" | Enter croc code, receive |
| Send over WAN (croc) | **Tools › Beam** (unchanged) | Start → code shown, exactly as today |
| Send over LAN | *(no UI)* | Any site on a machine with the channel set is automatically pullable; the receiver does the work |

Consequence: **Tools › Beam becomes croc-send-only.** No receive-via-croc and no
"get site from LAN" there (fetching another site from a random site's Tools tab is
the weird part we're removing).

If the channel isn't set when the user opens an Add-a-Site receive flow, just show a
one-line notice telling them to set it in Preferences — do **not** build deep-linking
(agreed: 10× simpler, same outcome).

### 2b. Hooks — what's available, what isn't

**Confirmed usable (build on these):**

- **`preferencesMenuItems`** (renderer filter, `renderer/preferences/index.js:62`) —
  push a pane into Local's Preferences window. Same shape as the `siteInfoToolsItem`
  hook we already use (`{ path, menuItem, render }`). This is the home for 2a's
  settings pane.
- **`siteInfoToolsItem`** — our existing Tools tab; stays for croc-send.
- **`AddSiteIndexJS:RoutesArray`** — add routes/steps to the Add-Site **wizard**
  (the flow *after* "Create a new site" → Continue). Could host the receive routes,
  but the entry point is awkward (see below).

**Other Create-a-Site content slots (for reference):**

| Hook | Renders | Args |
|---|---|---|
| `NewSiteEnvironment_EnvironmentDetails` | In the environment step, next to PHP/web-server/DB selectors | `{ disabled, … }` |
| `NewSiteSite_AfterContent` | After the site-name step | that step's `state` |
| `Blueprints_FromBlueprints:after` | After the blueprint list | — |
| `AddSiteIndexJS:NewSiteEnvironment` | filter env-step props (`siteSettings`, `onContinue`, button text) | — |
| `AddSiteIndexJS:RenderBreadcrumbs` / `:RenderCloseButton` | customize chrome | — |
| action `CreateSite:Mounted` | fires when the flow mounts | — |

**⚠️ NOT available — the Create-a-Site landing tiles (the mockup spot).**
The landing (`/main/create-site`) is rendered by `renderer/sites/CreateSite/CreateSite.js`
(150 lines). Its tile row is a **static** `RadioBlock` (`options: createSiteRadioOptions`,
built from a definitions store with no filter) plus a hardcoded "Select an existing
ZIP" block and Continue button. There is **no `doContent`/`applyFilters` anywhere in
that render** — so an add-on cannot inject a tile/button into that row.

The mockup ("Beam site from LAN" / "Beam site from WAN" tiles beside the ZIP import)
therefore needs one of:
1. **Preferences pane** as the receive home — supported, stable, but entry point is
   Local's Settings window, not the Create-a-Site tiles. **Recommended.**
2. **Add-Site wizard step** (`AddSiteIndexJS:RoutesArray`) — reachable only after
   "Create a new site" → Continue. Awkward placement.
3. **DOM / React-portal injection** into CreateSite's markup — exactly the mockup, but
   **unsupported**: renders inside Local's own tree; any release can change the
   markup/classNames and break or misalign it. Advise against for shipped software.

> **Action:** ask on the Local forum whether official hooks can be added for the
> Create-a-Site landing (a tile/option injection point). That would unblock the
> mockup cleanly and remove the need for option 3.

### 2c. Hook fragility — risk tiers

- **Low risk (blessed add-on hooks):** `siteInfoToolsItem`, `preferencesMenuItems`.
  Intended extension points, stable across many Local versions. Safe foundation.
- **Medium risk (internal component hooks):** `AddSiteIndexJS:*`, `NewSite*`.
  `HooksRenderer.deprecatedHooks` ships an explicit **rename map** (e.g.
  `siteInfo:webServer:*` → `SiteInfoEnvironmentWebServer[*]`) — proof Local renames
  these between releases but keeps a backward-compat shim, so old names keep working
  for a while.
- **Unavailable:** the Create-a-Site landing tile row (no hook).

**Failure modes (worst → acceptable):**
1. *Unguarded + shape changes* → our render callback throws **inside Local's React
   tree** → can white-screen the injected panel. The real danger.
2. *Feature-detected + no-op* → if a hook vanishes, our feature silently disappears,
   Local stays fine. Engineer for this.
3. *Renamed + shimmed* → keeps working.
4. *DOM-injection route only* → renders but can misalign on a Local CSS/markup refactor.

**Mitigation:** feature-detect every hook (`typeof hooks.addContent === 'function'`,
confirm it fired), wrap injected components in our **own** error boundary + try/catch,
keep them self-contained so a failure degrades to "Beam option missing," never
"Local broken." Note: a min-version floor (`engines.local-by-flywheel`) does **not**
protect against a *future* Local release removing/renaming a hook — only runtime
feature-detection does. `package.json` now declares `>=9.0.0` (bumped from `>=6.0.0`)
— a tested-compatibility declaration (we only test on 9+), not a technical requirement
of the current code, and no substitute for runtime feature-detection.
