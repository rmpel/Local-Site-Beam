# Changelog for LocalWP Plugin "Local Site Beam"

= 1.2.0 =

- Internet transfers no longer use croc. croc proved fragile in practice: it had to be installed separately (Homebrew), both machines had to run the *exact same* croc version (v10 silently broke against 9.x with cryptic "could not secure channel" errors), and transfers failed for no discernible reason often enough to be unreliable. Site Beam now ships its own transfer built entirely on Node's standard library — nothing to install, nothing to version-match between machines.
- How it works: both sides meet on a public "piping server" relay (default https://ppng.io) at a path derived from a hash of the one-time code phrase; the sender streams, the receiver pulls, the relay stores nothing. The payload is end-to-end encrypted (AES-256-GCM in authenticated framed chunks under a scrypt key derived from the phrase), so the relay only ever sees ciphertext and never learns the phrase. Reordering, truncation and tampering are detected, and an incompatible peer or corrupted stream produces a clear error. (A mistyped phrase makes both sides wait on different relay paths — cancel and re-check the phrase.)
- The relay is configurable in the UI (Internet transfer → Relay); self-host one with https://github.com/nwtgck/piping-server and point both machines at it for full control. Leave empty for the default.
- Real progress reporting for internet transfers (percentage + MB sent/received) instead of croc's raw terminal output.
- BREAKING for internet transfers only: both machines must run Site Beam 1.2.0+ (a 1.1.x sender speaks croc, which 1.2.0 no longer understands). LAN transfers are unaffected. The "Install croc with Homebrew" button is gone; croc can be uninstalled if nothing else uses it.

= 1.1.1 =

- Transferred sites with a fixed (non-variable) path baked into the web server conf templates (e.g. `DocumentRoot "/Users/x/some/old/path/app/public_html"` instead of `{{root}}`) failed to load on the destination when that path didn't match the source's registered site path — the sourcePath→destination rewrite found nothing to replace. The importer now additionally re-anchors every docroot directive (Apache `DocumentRoot`, the matching `<Directory>`, nginx `root`) that still points outside the destination site folder onto the destination, preserving the layout below `app/` (falling back to `app/<webRootName>`). Template variables like `{{root}}` and Apache boilerplate like `<Directory />` are left untouched.

= 1.1.0 =

- Released 2026-08-10.
- The machine's display name now follows the computer's hostname instead of being captured once: renaming the computer (e.g. macOS System Settings → General → About → Name) renames it in Site Beam after a reconnect or Local restart.
- Duplicated VMs are detected and repaired automatically: cloning a machine copies Local's `site-beam.json` and with it the instance id, which made the two clones invisible to each other. When another machine on the network is seen advertising this machine's id, a fresh id is generated and networking reconnects — no user action needed.
- New "Troubleshooting" section with a "Reset Site Beam settings" button that empties `site-beam.json` (shared code, manual peers and identity) and starts fresh.

= 1.0.1 =

- Released 2026-08-09.
- New icon: signal beam recolored blue, on a light tile color matching the first-party add-on style (`bgColor` in package.json).
- Removed the `slug` field from package.json: clicking the add-on tile made Local open its marketplace detail page, which crashes ("Cannot read properties of undefined (reading 'toString')") for add-ons not published in the marketplace. Without `slug` the tile is inert, like first-party unlisted add-ons.

= 1.0.0 =

- From Alpha 1; initial set-up of tranfer of websites from LocalWP on computer A to LocalWP on computer B, over LAN or using 3rd party util `croc` over WAN.
- From Alpha 2; properly preserve symlinks and hardlinks to the best ability.
- Released under GPLv3, see LICENSE for details.