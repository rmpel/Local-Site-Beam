'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { loadConfig, saveConfig, resetConfig, newInstanceId } = require('./lib/config');
const { deriveKey, fingerprint } = require('./lib/auth');
const Discovery = require('./lib/discovery');
const BeamServer = require('./lib/server');
const client = require('./lib/client');
const exporter = require('./lib/exporter');
const importer = require('./lib/importer');
const relay = require('./lib/relay');

const ADDON_VERSION = require('../package.json').version;

function lanAddresses() {
	const addresses = [];
	for (const iface of Object.values(os.networkInterfaces() || {})) {
		for (const info of iface || []) {
			if (info.family === 'IPv4' && !info.internal) {
				addresses.push(info.address);
			}
		}
	}
	return addresses;
}

function tmpWorkDir() {
	return path.join(os.tmpdir(), 'local-site-beam', `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
}

/*
 * Local provisions sites via a recursive mkdir of
 * run/router/nginx/conf/local-router-error-pages — which throws EEXIST only
 * when a NON-directory (stale file / broken symlink) occupies that path, and
 * that state survives Local restarts, breaking every subsequent site
 * provisioning. Clear it surgically; a real directory there is normal and is
 * left alone.
 */
function clearStaleRouterState(context, logger) {
	try {
		const errorPages = path.join(
			context.environment.userDataPath,
			'run', 'router', 'nginx', 'conf', 'local-router-error-pages'
		);
		const stat = fs.lstatSync(errorPages);
		if (!stat.isDirectory()) {
			fs.rmSync(errorPages, { force: true, recursive: true });
			logger.warn(`Site Beam: removed stale non-directory at ${errorPages} — it was breaking site provisioning`);
		}
	} catch (err) {
		// Path absent (normal before the router first runs) or unreadable.
	}
}

/*
 * If the router conf dir exists but its skeleton is incomplete (seen after
 * run/router was cleared while Local kept stale in-memory state), site
 * provisioning fails halfway with confusing ENOENT/chmod errors and Local
 * rolls the site back. Fail early with an instruction instead.
 */
function assertRouterHealthy(context) {
	const confDir = path.join(context.environment.userDataPath, 'run', 'router', 'nginx', 'conf');
	if (!fs.existsSync(confDir)) {
		// Router not provisioned yet — Local builds it on first site start.
		return;
	}
	// A half-built skeleton (run/router cleared while Local kept stale in-memory
	// state) is missing core nginx includes Local copies from its router-config
	// resources. Provisioning then dies mid-copy — observed as ENOENT on
	// server-block-ssl.conf and, on Local 10.1.x, location-block.conf — and
	// Local rolls the site back. Both are present on a healthy router, so treat
	// either being absent as an incomplete skeleton and fail early with a fix.
	const missing = ['server-block-ssl.conf', 'location-block.conf']
		.find((file) => !fs.existsSync(path.join(confDir, file)));
	if (missing) {
		throw new Error(`Local's router configuration on this machine is incomplete (${missing} is missing). In Local, start or restart any existing site once — that rebuilds the router — then retry the transfer.`);
	}
}

function withRouterHint(err) {
	// Covers both directory-token forms Local logs (run/router and the
	// unresolved %%router.runPath%%) plus the specific router-config files whose
	// copy fails on a half-built skeleton (server-block*, location-block,
	// local-router-error-pages).
	if (/run\/router|router\.runPath|router-config|server-block|location-block|local-router-error-pages/.test(String(err && err.message))) {
		err.message += " — Local's site router state looks broken on this machine. Start or restart any existing site once in Local (this rebuilds the router), then retry the transfer.";
	}
	return err;
}

function main(context) {
	const cradle = LocalMain.getServiceContainer().cradle;
	const logger = cradle.localLogger.child({ thread: 'main', addon: 'site-beam' });

	const state = {
		config: loadConfig(),
		key: null,
		server: null,
		discovery: null,
		networkError: null,
		transfer: null,               // active/last LAN pull
		wan: { sending: null, receiving: null, cancel: {} },
	};

	importer.registerHooks(cradle, logger);

	async function startNetworking() {
		stopNetworking();
		// Re-read the config so the display name picks up a renamed machine
		// (all mutations are saved before this runs, so nothing is lost).
		state.config = loadConfig();
		const code = state.config.sharedCode;
		if (!code) {
			return;
		}
		state.networkError = null;
		try {
			state.key = deriveKey(code);
			state.server = new BeamServer({
				key: state.key,
				cradle,
				logger,
				displayName: state.config.displayName,
				version: ADDON_VERSION,
			});
			const port = await state.server.listen();
			state.discovery = new Discovery({
				fp: fingerprint(code),
				instanceId: state.config.instanceId,
				displayName: state.config.displayName,
				port,
				logger,
				onConflict: () => {
					// Another machine advertises our instanceId — Local's user
					// data (site-beam.json) was duplicated along with a VM.
					// Regenerate our identity and reconnect; both sides doing
					// this is harmless, the ids simply diverge.
					state.config.instanceId = newInstanceId();
					saveConfig(state.config);
					logger.warn('Site Beam: another machine on the network uses this machine\'s identity (duplicated VM?) — generated a new instance id and reconnecting.');
					startNetworking();
				},
			});
			state.discovery.start();
			logger.info(`Site Beam listening on port ${port}`);
		} catch (err) {
			logger.error(`Site Beam could not start networking: ${err.message}`);
			state.networkError = err.message;
			stopNetworking();
		}
	}

	function stopNetworking() {
		if (state.discovery) {
			state.discovery.stop();
			state.discovery = null;
		}
		if (state.server) {
			state.server.close();
			state.server = null;
		}
		state.key = null;
	}

	function localSitesSummary() {
		return Object.values(cradle.siteData.getSites() || {}).map((s) => ({
			id: s.id,
			name: s.name,
			domain: s.domain,
		})).sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	function publicTransfer() {
		if (!state.transfer) {
			return null;
		}
		const { kind, siteName, phase, message, bytesReceived, startedAt, done, error, resultName } = state.transfer;
		return { kind, siteName, phase, message, bytesReceived, startedAt, done, error, resultName };
	}

	function publicWan() {
		const strip = (job) => job && {
			siteName: job.siteName,
			phrase: job.phrase,
			phase: job.phase,
			message: job.message,
			done: job.done,
			error: job.error,
			resultName: job.resultName,
		};
		return {
			relay: relay.relayBase(state.config.relayUrl),
			relayIsDefault: relay.relayBase(state.config.relayUrl) === relay.DEFAULT_RELAY,
			sending: strip(state.wan.sending),
			receiving: strip(state.wan.receiving),
		};
	}

	function peersList() {
		const peers = state.discovery ? state.discovery.peers() : [];
		for (const address of state.config.manualPeers) {
			const [host, portRaw] = String(address).split(':');
			const port = Number(portRaw) || 47600;
			if (!peers.some((p) => p.host === host && p.port === port)) {
				peers.push({ id: `manual:${address}`, name: address, host, port, via: 'manual', lastSeen: null });
			}
		}
		return peers;
	}

	function transferBusy() {
		return (state.transfer && !state.transfer.done && !state.transfer.error)
			|| (state.wan.receiving && !state.wan.receiving.done && !state.wan.receiving.error);
	}

	async function pullFromPeer({ peer, siteId, siteName, mode }) {
		if (transferBusy()) {
			throw new Error('Another transfer is already in progress.');
		}
		if (!state.key) {
			throw new Error('Set a shared code first.');
		}
		const transfer = {
			kind: 'lan',
			siteName: siteName || siteId,
			phase: 'downloading',
			message: `Downloading from ${peer.host}…`,
			bytesReceived: 0,
			startedAt: Date.now(),
			done: false,
			error: null,
			resultName: null,
		};
		state.transfer = transfer;
		const workDir = tmpWorkDir();
		try {
			clearStaleRouterState(context, logger);
			assertRouterHealthy(context);
			fs.mkdirSync(workDir, { recursive: true });
			const zipPath = path.join(workDir, 'export.zip');
			await client.downloadToFile(peer, state.key, `/beam/v1/export/${siteId}`, zipPath, (bytes) => {
				transfer.bytesReceived = bytes;
			});
			const onProgress = (phase, message) => {
				transfer.phase = phase;
				transfer.message = message;
			};
			const { site, action } = await importer.importZipFile(cradle, logger, zipPath, mode || 'new', onProgress);
			transfer.phase = 'done';
			transfer.done = true;
			transfer.resultName = site.name;
			transfer.message = action === 'overwritten'
				? `Overwrote "${site.name}" with the copy from ${peer.name || peer.host}.`
				: `"${site.name}" is ready. If pages don't load, check the site's web server and PHP version in Local — those sometimes need re-selecting on this machine.`;
			context.notifier.notify({ title: 'Site Beam', message: transfer.message });
			return { ok: true, siteName: site.name, action };
		} catch (err) {
			withRouterHint(err);
			transfer.phase = 'error';
			transfer.error = err.message;
			transfer.message = err.message;
			logger.error(`Site Beam pull failed: ${err.message}`);
			throw err;
		} finally {
			fs.rm(workDir, { recursive: true, force: true }, () => {});
		}
	}

	// ---- IPC surface ----

	LocalMain.addIpcAsyncListener('site-beam:get-state', async () => ({
		version: ADDON_VERSION,
		codeSet: !!state.config.sharedCode,
		displayName: state.config.displayName,
		networkError: state.networkError,
		listening: state.server ? { port: state.server.port, addresses: lanAddresses() } : null,
		peers: peersList(),
		localSites: localSitesSummary(),
		transfer: publicTransfer(),
		wan: publicWan(),
	}));

	LocalMain.addIpcAsyncListener('site-beam:set-code', async ({ code }) => {
		state.config.sharedCode = String(code || '').trim();
		saveConfig(state.config);
		await startNetworking();
		return { ok: true, listening: state.server ? state.server.port : null, error: state.networkError };
	});

	LocalMain.addIpcAsyncListener('site-beam:peer-sites', async ({ host, port }) => {
		if (!state.key) {
			throw new Error('Set a shared code first.');
		}
		const peer = { host, port };
		const { sites } = await client.getJSON(peer, state.key, '/beam/v1/sites');
		const mine = localSitesSummary();
		for (const site of sites) {
			const existing = mine.find((m) =>
				m.name.trim().toLowerCase() === String(site.name || '').trim().toLowerCase()
				|| (site.domain && m.domain && m.domain.toLowerCase() === site.domain.toLowerCase())
			);
			site.existsLocally = !!existing;
			site.existingName = existing ? existing.name : null;
		}
		return { sites };
	});

	LocalMain.addIpcAsyncListener('site-beam:pull', (args) => pullFromPeer(args));

	LocalMain.addIpcAsyncListener('site-beam:clear-transfer', async () => {
		if (state.transfer && (state.transfer.done || state.transfer.error)) {
			state.transfer = null;
		}
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:add-manual-peer', async ({ address }) => {
		const cleaned = String(address || '').trim();
		if (!/^[A-Za-z0-9_.-]+(:\d+)?$/.test(cleaned)) {
			throw new Error('Use the form host-or-ip:port, e.g. 192.168.1.20:47600');
		}
		if (!state.config.manualPeers.includes(cleaned)) {
			state.config.manualPeers.push(cleaned);
			saveConfig(state.config);
		}
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:remove-manual-peer', async ({ address }) => {
		state.config.manualPeers = state.config.manualPeers.filter((a) => a !== address);
		saveConfig(state.config);
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:reset-config', async () => {
		stopNetworking();
		state.config = resetConfig();
		state.networkError = null;
		return { ok: true };
	});

	// ---- internet transfers (built-in encrypted relay) ----

	LocalMain.addIpcAsyncListener('site-beam:wan-send', async ({ siteId }) => {
		if (state.wan.sending && !state.wan.sending.done && !state.wan.sending.error) {
			throw new Error('An internet send is already in progress.');
		}
		const siteJson = cradle.siteData.getSite(siteId);
		if (!siteJson) {
			throw new Error('Site not found.');
		}
		const job = {
			siteName: siteJson.name,
			phrase: relay.generatePhrase(),
			phase: 'exporting',
			message: 'Building export zip… you can already share the code phrase with the other machine.',
			done: false,
			error: null,
		};
		state.wan.sending = job;
		const workDir = tmpWorkDir();
		(async () => {
			try {
				const slug = String(siteJson.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
				const zipPath = path.join(workDir, `${slug}-beam.zip`);
				await exporter.writeExportZipFile(cradle, logger, siteJson, zipPath);
				job.phase = 'sending';
				const { cancel, done } = relay.send(zipPath, job.phrase, (line) => {
					job.message = line;
				}, state.config.relayUrl);
				state.wan.cancel.send = cancel;
				const summary = await done;
				logger.info(`Site Beam internet send finished: ${summary}`);
				job.phase = 'done';
				job.done = true;
				job.message = `"${siteJson.name}" sent.`;
				context.notifier.notify({ title: 'Site Beam', message: job.message });
			} catch (err) {
				job.phase = 'error';
				job.error = err.message;
				job.message = err.message;
				logger.error(`Site Beam internet send failed: ${err.message}`);
			} finally {
				delete state.wan.cancel.send;
				fs.rm(workDir, { recursive: true, force: true }, () => {});
			}
		})();
		return { ok: true, phrase: job.phrase };
	});

	LocalMain.addIpcAsyncListener('site-beam:wan-receive', async ({ phrase, mode }) => {
		if (transferBusy()) {
			throw new Error('Another transfer is already in progress.');
		}
		const cleaned = String(phrase || '').trim();
		if (!cleaned) {
			throw new Error('Enter the code phrase shown on the sending machine.');
		}
		const job = {
			siteName: null,
			phrase: cleaned,
			phase: 'receiving',
			message: 'Connecting to the relay…',
			done: false,
			error: null,
			resultName: null,
		};
		state.wan.receiving = job;
		const workDir = tmpWorkDir();
		(async () => {
			try {
				clearStaleRouterState(context, logger);
				assertRouterHealthy(context);
				const { cancel, done } = relay.receive(cleaned, workDir, (line) => {
					job.message = line;
				}, state.config.relayUrl);
				state.wan.cancel.receive = cancel;
				await done;
				delete state.wan.cancel.receive;
				const zip = fs.readdirSync(workDir).find((f) => f.toLowerCase().endsWith('.zip'));
				if (!zip) {
					throw new Error('The transfer finished but no zip file was received.');
				}
				const { site, action } = await importer.importZipFile(
					cradle, logger, path.join(workDir, zip), mode || 'new',
					(phase, message) => {
						job.phase = phase;
						job.message = message;
					}
				);
				job.phase = 'done';
				job.done = true;
				job.resultName = site.name;
				job.message = action === 'overwritten'
					? `Overwrote "${site.name}" with the received copy.`
					: `"${site.name}" is ready.`;
				context.notifier.notify({ title: 'Site Beam', message: job.message });
			} catch (err) {
				withRouterHint(err);
				job.phase = 'error';
				job.error = err.message;
				job.message = err.message;
				logger.error(`Site Beam internet receive failed: ${err.message}`);
			} finally {
				delete state.wan.cancel.receive;
				fs.rm(workDir, { recursive: true, force: true }, () => {});
			}
		})();
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:wan-cancel', async ({ which }) => {
		const cancel = state.wan.cancel[which];
		if (cancel) {
			cancel();
		}
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:wan-clear', async ({ which }) => {
		const job = state.wan[which === 'send' ? 'sending' : 'receiving'];
		if (job && (job.done || job.error)) {
			state.wan[which === 'send' ? 'sending' : 'receiving'] = null;
		}
		return { ok: true };
	});

	LocalMain.addIpcAsyncListener('site-beam:set-relay', async ({ relayUrl }) => {
		const cleaned = String(relayUrl || '').trim();
		if (cleaned && !/^https?:\/\/[^\s]+$/.test(cleaned)) {
			throw new Error('Enter a full relay URL, e.g. https://ppng.io — or leave it empty for the default.');
		}
		state.config.relayUrl = cleaned;
		saveConfig(state.config);
		return { ok: true, relay: relay.relayBase(cleaned) };
	});

	clearStaleRouterState(context, logger);
	startNetworking();
}

module.exports = main;
module.exports.default = main;
