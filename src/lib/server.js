'use strict';

const http = require('http');

const Local = require('@getflywheel/local');

const { verifyRequest } = require('./auth');
const { writeExportArchive } = require('./exporter');

const BASE_PORT = 47600;
const PORT_ATTEMPTS = 20;

class BeamServer {
	constructor({ key, cradle, logger, displayName, version }) {
		this.key = key;
		this.cradle = cradle;
		this.logger = logger;
		this.displayName = displayName;
		this.version = version;
		this.server = null;
		this.port = null;
	}

	listen() {
		return new Promise((resolve, reject) => {
			const tryPort = (port, attemptsLeft) => {
				const server = http.createServer((req, res) => this.handle(req, res));
				server.once('error', (err) => {
					if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
						tryPort(port + 1, attemptsLeft - 1);
					} else {
						reject(err);
					}
				});
				server.listen(port, () => {
					this.server = server;
					this.port = port;
					resolve(port);
				});
			};
			tryPort(BASE_PORT, PORT_ATTEMPTS);
		});
	}

	close() {
		if (this.server) {
			try {
				this.server.close();
			} catch (err) { /* shutting down */ }
			this.server = null;
			this.port = null;
		}
	}

	json(res, statusCode, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(statusCode, { 'content-type': 'application/json' });
		res.end(body);
	}

	async handle(req, res) {
		let pathname;
		try {
			pathname = new URL(req.url, 'http://localhost').pathname;
		} catch (err) {
			return this.json(res, 400, { error: 'Bad request' });
		}
		const ts = req.headers['x-beam-ts'];
		const sig = req.headers['x-beam-sig'];
		if (!verifyRequest(this.key, req.method, pathname, ts, sig)) {
			return this.json(res, 401, { error: 'Not authorized (shared code mismatch or clock skew over 5 minutes)' });
		}
		try {
			if (req.method === 'GET' && pathname === '/beam/v1/ping') {
				return this.json(res, 200, {
					ok: true,
					name: this.displayName,
					version: this.version,
					sites: Object.keys(this.cradle.siteData.getSites() || {}).length,
				});
			}
			if (req.method === 'GET' && pathname === '/beam/v1/sites') {
				return this.json(res, 200, { sites: await this.listSites() });
			}
			const exportMatch = req.method === 'GET' && pathname.match(/^\/beam\/v1\/export\/([A-Za-z0-9_-]+)$/);
			if (exportMatch) {
				return await this.handleExport(exportMatch[1], res);
			}
			return this.json(res, 404, { error: 'Not found' });
		} catch (err) {
			this.logger.warn(`Site Beam server error on ${pathname}: ${err.message}`);
			if (!res.headersSent) {
				return this.json(res, err.statusCode || 500, { error: err.message });
			}
			res.destroy(err);
		}
	}

	async listSites() {
		const { siteData, siteProcessManager } = this.cradle;
		const sites = Object.values(siteData.getSites() || {});
		const results = [];
		for (const siteJson of sites) {
			let status = 'unknown';
			try {
				status = await Promise.resolve(siteProcessManager.getSiteStatus(new Local.Site(siteJson)));
			} catch (err) {
				// status stays unknown
			}
			const services = siteJson.services || {};
			const byRole = (role, fallback) => {
				const svc = Object.values(services).find((s) => s && s.role === role);
				return svc ? svc.version : (siteJson[fallback] || null);
			};
			results.push({
				id: siteJson.id,
				name: siteJson.name,
				domain: siteJson.domain,
				multiSite: siteJson.multiSite || false,
				status,
				php: byRole('php', 'phpVersion'),
				mysql: byRole('db', 'mysqlVersion'),
			});
		}
		return results.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	async handleExport(siteId, res) {
		const siteJson = this.cradle.siteData.getSite(siteId);
		if (!siteJson) {
			return this.json(res, 404, { error: `No site with id ${siteId}` });
		}
		this.logger.info(`Site Beam: streaming export of "${siteJson.name}" to a peer`);
		await writeExportArchive(this.cradle, this.logger, siteJson, res, {
			beforeStream: () => res.writeHead(200, {
				'content-type': 'application/zip',
				'x-beam-site-name': encodeURIComponent(siteJson.name),
			}),
		});
	}
}

module.exports = BeamServer;
