'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * LAN peer discovery via mDNS/Bonjour.
 *
 * Each machine publishes a `localbeam` service whose TXT record carries a
 * fingerprint of the shared code. Peers only show up when fingerprints match,
 * so machines with a different (or no) code are invisible to each other.
 */

const os = require('os');

const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'localbeam';
const REFRESH_INTERVAL_MS = 15000;
const PEER_TTL_MS = 90000;

function localAddressSet() {
	const set = new Set();
	for (const iface of Object.values(os.networkInterfaces() || {})) {
		for (const info of iface || []) {
			set.add(normalizeAddress(info.address));
		}
	}
	return set;
}

function normalizeAddress(address) {
	return String(address || '').toLowerCase().replace(/%.*$/, '').replace(/^::ffff:/, '');
}

class Discovery {
	constructor({ fp, instanceId, displayName, port, logger, onConflict }) {
		this.fp = fp;
		this.instanceId = instanceId;
		this.displayName = displayName;
		this.port = port;
		this.logger = logger;
		this.onConflict = onConflict;
		this.conflictFired = false;
		this.peersMap = new Map();
		this.bonjour = null;
		this.browser = null;
		this.interval = null;
	}

	start() {
		this.bonjour = new Bonjour(undefined, (err) => {
			if (err && this.logger) {
				this.logger.warn(`Site Beam mDNS error: ${err.message || err}`);
			}
		});
		// Advertise a host record DISTINCT from the machine's real hostname.
		// bonjour-service runs its own mDNS responder; if it claims the same
		// host name macOS's mDNSResponder already owns, macOS detects a
		// conflict and renames the machine ("MacBook (2)"), breaking
		// connectivity. The instanceId suffix keeps the name unique even
		// between machines that share a hostname.
		const uniqueHost = `${os.hostname().replace(/\.local$/i, '')}-LocalWP-${this.instanceId.slice(0, 4)}.local`;
		const service = this.bonjour.publish({
			name: `beam-${this.instanceId.slice(0, 8)}`,
			type: SERVICE_TYPE,
			host: uniqueHost,
			port: this.port,
			txt: {
				v: '1',
				id: this.instanceId,
				fp: this.fp,
				name: this.displayName,
			},
		});
		if (service && typeof service.on === 'function') {
			service.on('error', (err) => {
				if (this.logger) {
					this.logger.warn(`Site Beam mDNS publish error: ${err.message || err}`);
				}
			});
		}
		this.browser = this.bonjour.find({ type: SERVICE_TYPE });
		if (typeof this.browser.on === 'function') {
			this.browser.on('error', (err) => {
				if (this.logger) {
					this.logger.warn(`Site Beam mDNS browse error: ${err.message || err}`);
				}
			});
		}
		this.browser.on('up', (service) => this.onUp(service));
		this.browser.on('down', (service) => this.onDown(service));
		this.interval = setInterval(() => {
			try {
				this.browser.update();
			} catch (err) {
				// mDNS refresh is best-effort
			}
			const now = Date.now();
			for (const [id, peer] of this.peersMap) {
				if (now - peer.lastSeen > PEER_TTL_MS) {
					this.peersMap.delete(id);
				}
			}
		}, REFRESH_INTERVAL_MS);
	}

	onUp(service) {
		const txt = service.txt || {};
		if (txt.fp !== this.fp || !txt.id) {
			return;
		}
		const addresses = service.addresses || [];
		const local = localAddressSet();
		const fromThisMachine = addresses.some((a) => local.has(normalizeAddress(a)));
		if (txt.id === this.instanceId) {
			// Our own advertisement echoes back — normal. But the same id from a
			// FOREIGN address means another machine carries our identity: this
			// happens when a VM (and thus Local's user-data, including
			// site-beam.json) was duplicated. Report it so the identity can be
			// regenerated; without this the clones silently ignore each other.
			if (addresses.length && !fromThisMachine && !this.conflictFired && this.onConflict) {
				this.conflictFired = true;
				this.onConflict(service);
			}
			return;
		}
		if (fromThisMachine) {
			// A stale advertisement of ourselves under a previous instanceId
			// (mDNS caches outlive an identity regeneration) — never a peer.
			return;
		}
		const host = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || addresses[0] || service.host;
		if (!host || !service.port) {
			return;
		}
		this.peersMap.set(txt.id, {
			id: txt.id,
			name: txt.name || service.name || host,
			host,
			port: service.port,
			via: 'mdns',
			lastSeen: Date.now(),
		});
	}

	onDown(service) {
		const txt = service.txt || {};
		if (txt.id) {
			this.peersMap.delete(txt.id);
		}
	}

	peers() {
		return [...this.peersMap.values()];
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		try {
			if (this.bonjour) {
				this.bonjour.unpublishAll(() => {
					try {
						this.bonjour.destroy();
					} catch (err) { /* already gone */ }
				});
			}
		} catch (err) {
			// shutting down anyway
		}
		this.bonjour = null;
		this.browser = null;
		this.peersMap.clear();
	}
}

module.exports = Discovery;
module.exports.SERVICE_TYPE = SERVICE_TYPE;
