# Local Site Beam - Beam your site to another LocalWP installation.

## LICENSING

Copyright (C) 2026 Remon Pel.

This software is released under the GNU General Public License v3.0 (or, at
your option, any later version). The full license text is in the [LICENSE](LICENSE)
file that ships with every copy.

This means:

- You can use it however you like for both personal and business projects.
- If you modify and distribute your own version, you must share your source code under this exact same license.
- You cannot strip my name or copyright notice; proper attribution must always remain.
- While the license technically allows distribution, any copies must remain fully open-source, ensuring it stays free for everyone forever.

## Changelog

Can be found in [CHANGELOG.md](CHANGELOG.md)

## Co-authored by Claude, Fable 5

This project is written by myself and Claude, Fable 5, and tested by myself on local hardware, two laptops on the same LAN.

## NO LIABILITY!!!!

Use at your own risk!!!!

Just because it works for me, does not mean it will work for you!

Feel free to burn it down!

I welcome every comment, positive as well as negative (though you might hurt my feelings and I might shout at you, but that's just because I care!)

Feel free to contribute!

## Prerequisites

For LAN mode, no extenal dependencies

For WAN mode, uses croc (brew install croc) and must have identical version on both sides (brew upgrade croc)

## LIMITED TESTING

Testing is limited to 1 person, 2 laptops, 3 beers on one late evening.

Don't expect things to be perfect!

## Known issues

- After transfer, you might have to re-configure Apache/nginx and/or php version
- You might need to manually fix the database credentials (for example, if you list the socket path in your config, remove or re-do)

## Installing; 

- Clone repo
- Shut down LocalWP
- run ./script/install.sh
- start LocalWP
- enable Plugin
- restart LocalWP

## Quick start;

- go to any site
- go to Tools panel
- go to Site Beam

### LAN mode

- Set up a secret key on both (or more) machines
- Browse sites
- Click the button to transfer

### WAN mode

- Choose a site
- Click send
- Copy the code
- Send code to other computer (easy with Mac, or use WhatsApp or Slack, or whatever)
- On receiving computer, paste code and click receive

## Documentation as written by Fable 5, and read/re-read/re-written by me, your host, Remon;

A Local add-on that lets two or more computers running [Local](https://localwp.com)
find each other on the local network via a **shared code** and copy **complete
sites** (all files + full database) from one machine to another. Effectively
"export on machine A, transfer export over, import on machine B" — in one click.

- **Discovery**: mDNS/Bonjour. Machines only see each other when they have the
  *same* shared code (only a hash fingerprint of the code is broadcast).
- **Authentication**: every request between peers is HMAC-signed with a key
  derived from the code. The code itself never travels over the network.
- **Transfer format**: the entire site folder with its real layout preserved
  (custom web roots like `app/public_html`, composer `vendor/`, root-level
  files, `conf/` templates), excluding `mysqldata/` and `logs/` — the database
  travels as a fresh portable dump at `app/sql/local.sql`. `local-site.json`
  is included, so the zip can also be dragged into Local manually as a fallback.
- **Custom environments**: sites whose web root isn't `app/public` (detected
  from the Apache/nginx conf template) are recreated on the destination as a
  custom environment with the source's web server + PHP version, and the
  source `conf/` is restored with absolute paths rewritten to the new site
  folder. (Though default folder structure might remain after import).
- **Import**: rides Local's own site-creation flow (the same pattern the
  official Cloud Backups add-on uses), then restores files, imports the
  database and rewrites URLs to the new host.
- **Conflict handling**: if a site with the same name or domain already exists
  on the receiving machine it is **not** transferred by default; the UI offers
  **Copy as new** (renamed, e.g. "My Site 2") or **Overwrite** (replaces local
  files + database, with an explicit are-you-sure step).
- **Internet transfers (optional)**: if [croc](https://github.com/schollz/croc)
  is installed, sites can also be sent between machines on *different*
  networks using a one-time code phrase (end-to-end encrypted via the public
  croc relay). If croc is missing and Homebrew is present, the UI offers a
  one-click install.

## Install (each computer)

Requirements: Local 9+ (tested against the Local 9/10-era add-on API), Node
+ npm available on the machine (only to install the add-on's dependencies).

### macOS / Linux

```sh
git clone <this-folder-or-repo> local-site-beam   # or copy the folder
cd local-site-beam

# Either; Build it and install from dist/*zip
./scripts/build.sh
# Or; install from source
./scripts/install.sh
```

The script runs `npm install` and symlinks the folder into Local's add-ons
directory (`~/Library/Application Support/Local/addons` on macOS,
`~/.config/Local/addons` on Linux).

### Windows

I'm sorry, I'm not a Windows person. If you have a better way, please contribute.

1. Copy this folder to `%AppData%\Local\addons\local-site-beam`.
2. Inside it, run `npm install --omit=dev`.

### Then, on every machine

1. Restart Local → **Add-ons → Installed** → enable **Site Beam** → relaunch.
2. Open any site → **Tools → Site Beam**.
3. Enter the same shared code on every computer → **Save & connect**.

Other machines appear under "Computers on your network" within ~15 seconds.
Click **Browse sites**, then **Copy to this computer** on any site.

## Usage notes

- **Source site database**: a running site is dumped fresh at transfer time. A
  stopped site uses the dump Local wrote when it was last stopped; a site that
  has never run on the source machine can't be exported until it's started at 
  least once.
- **New sites land** in the directory where most of your existing sites live
  (fallback: `~/Local Sites`), with the PHP/MySQL environment of your Local
  defaults. Files and database are exact copies of the source.
- **Web server / PHP version**: Local doesn't always fully apply the source's
  environment when creating the site programmatically — if pages don't load
  after a transfer, re-select the web server (Apache/nginx) and PHP version
  once in the site's settings on the receiving machine.
- **Machine-specific DB sockets**: `.env` / `wp-config.php` entries like
  `DB_HOST="localhost:/…/run/<id>/mysql/mysqld.sock"` are rewritten to plain
  `localhost` on import (the source socket path can't exist on the target;
  Local's per-site php.ini supplies the right default socket). Standalone
  `DB_SOCKET=`-style variables are left untouched.
- **macOS firewall**: the first time, allow Local to accept incoming
  connections, or peers can't download from this machine.
- **Discovery blocked?** Some networks (VLANs, guest Wi-Fi, VPNs) block mDNS.
  Use "Add by address" with the `ip:port` shown on the other machine.
- One transfer at a time per receiving machine.

## Internet transfer via croc

On the sending machine choose a site → **Send**; a code phrase like
`beam-a1b2-c3d4-e5f6` appears. On the receiving machine, enter that phrase
(and pick the conflict behaviour) → **Receive**. Works across the internet —
no shared code or same-network requirement; the phrase *is* the secret, share
it out-of-band, and only with those you trust.

## Security model (v1)

Designed for trusted LANs: request signing prevents access by machines without
the code, but the site payload itself is transferred over plain HTTP on your
local network (croc transfers are end-to-end encrypted). Don't use the LAN
mode on networks you don't trust.

## Known limitations / roadmap

- Receiving site gets the default Local environment (PHP/MySQL versions from
  the source are recorded in `beam-manifest.json` but not yet pinned on import).
- No transfer resume; a failed download starts over.
- No push — transfers are always pulled from the receiving machine (LAN) or
  code-phrase based (croc).
