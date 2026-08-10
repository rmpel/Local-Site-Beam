# Changelog for LocalWP Plugin "Local Site Beam"

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