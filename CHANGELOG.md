# Changelog for LocalWP Plugin "Local Site Beam"

= 1.0.1 =

- Released 2026-08-09.
- New icon: signal beam recolored blue, on a light tile color matching the first-party add-on style (`bgColor` in package.json).
- Removed the `slug` field from package.json: clicking the add-on tile made Local open its marketplace detail page, which crashes ("Cannot read properties of undefined (reading 'toString')") for add-ons not published in the marketplace. Without `slug` the tile is inert, like first-party unlisted add-ons.

= 1.0.0 =

- From Alpha 1; initial set-up of tranfer of websites from LocalWP on computer A to LocalWP on computer B, over LAN or using 3rd party util `croc` over WAN.
- From Alpha 2; properly preserve symlinks and hardlinks to the best ability.
- Released under GPLv3, see LICENSE for details.