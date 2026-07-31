'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/* Integration test for the Site Beam add-on, run outside Local by stubbing
 * the @getflywheel/local API surface (as documented from the real type defs).
 * Simulates source machine A and destination machine B in one process. 
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');

const ADDON = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));

// ---------- stubs for Local's runtime-provided modules ----------

const ipcEvents = [];
const filters = new Map();
const actions = new Map();

class StubSite {
	constructor(json) { Object.assign(this, json); }
	get paths() {
		return {
			app: path.join(this.path, 'app'),
			webRoot: path.join(this.path, 'app', 'public'),
			sql: path.join(this.path, 'app', 'sql'),
		};
	}
	get host() { return this.domain; }
}

const LocalStub = { Site: StubSite };

const userDataStore = {};
const LocalMainStub = {
	formatHomePath: (p) => p,
	formatSiteNicename: (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
	sendIPCEvent: (...args) => ipcEvents.push(args),
	addIpcAsyncListener: () => {},
	UserData: {
		get: (name, defaults) => userDataStore[name] || defaults,
		set: (name, data) => { userDataStore[name] = data; },
	},
	HooksMain: {
		addFilter: (name, cb) => filters.set(name, [...(filters.get(name) || []), cb]),
		addAction: (name, cb) => actions.set(name, [...(actions.get(name) || []), cb]),
	},
	getServiceContainer: () => ({ cradle: {} }),
};
const applyFilters = (name, value, ...args) =>
	(filters.get(name) || []).reduce((v, cb) => cb(v, ...args), value);
const doActions = async (name, ...args) => {
	for (const cb of actions.get(name) || []) { await cb(...args); }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === '@getflywheel/local') return LocalStub;
	if (request === '@getflywheel/local/main') return LocalMainStub;
	if (request === '@getflywheel/local/renderer') return { ipcAsync: async () => ({}) };
	return realLoad.call(this, request, parent, isMain);
};

// ---------- fake source machine A ----------

function makeSiteDir(root, marker) {
	fs.mkdirSync(path.join(root, 'app', 'public', 'wp-content'), { recursive: true });
	fs.mkdirSync(path.join(root, 'app', 'sql'), { recursive: true });
	fs.writeFileSync(path.join(root, 'app', 'public', 'index.php'), `<?php // ${marker}`);
	fs.writeFileSync(path.join(root, 'app', 'public', 'wp-content', 'marker.txt'), marker);
	fs.writeFileSync(path.join(root, 'app', 'sql', 'local.sql'), `-- dump ${marker}\nCREATE TABLE wp_options (x int);`);
}

const siteAPath = path.join(TMP, 'machine-a', 'flux-demo');
makeSiteDir(siteAPath, 'FROM-MACHINE-A');
// In-root symlink (must survive as a relative link) and hardlink pair
// (must arrive sharing one inode again).
const aContent = path.join(siteAPath, 'app', 'public', 'wp-content');
fs.mkdirSync(path.join(aContent, 'plugins', 'real-plugin'), { recursive: true });
fs.writeFileSync(path.join(aContent, 'plugins', 'real-plugin', 'plugin.php'), '<?php // real');
fs.symlinkSync('plugins', path.join(aContent, 'plugins-link'));
fs.mkdirSync(path.join(aContent, 'uploads'), { recursive: true });
fs.writeFileSync(path.join(aContent, 'uploads', 'original.txt'), 'same inode');
fs.linkSync(path.join(aContent, 'uploads', 'original.txt'), path.join(aContent, 'uploads', 'linked.txt'));

// Custom-environment site modeled on the real "4ortho" layout:
// web root app/public_html, composer siblings, conf/ with absolute DocumentRoot.
const siteCPath = path.join(TMP, 'machine-a', 'ortho');
fs.mkdirSync(path.join(siteCPath, 'app', 'public_html', 'wp-content'), { recursive: true });
// Dev pattern: the default web root app/public is a symlink to the real one.
// Local pre-creates a real empty app/public on the destination, so the importer
// must clear it before restoring this link (else fs.cp aborts the app copy).
fs.symlinkSync('public_html', path.join(siteCPath, 'app', 'public'));
fs.mkdirSync(path.join(siteCPath, 'app', 'vendor'), { recursive: true });
fs.mkdirSync(path.join(siteCPath, 'app', 'sql'), { recursive: true });
fs.mkdirSync(path.join(siteCPath, 'conf', 'apache'), { recursive: true });
fs.mkdirSync(path.join(siteCPath, 'logs'), { recursive: true });
fs.mkdirSync(path.join(siteCPath, 'mysqldata'), { recursive: true });
fs.writeFileSync(path.join(siteCPath, 'app', 'public_html', 'wp-content', 'marker.txt'), 'CUSTOM-A');
fs.writeFileSync(path.join(siteCPath, 'app', 'public_html', '.env'),
	`DB_HOST="localhost:/Users/someone/Library/Application Support/Local/run/ccc333/mysql/mysqld.sock"\nDB_SOCKET=/keep/this/mysqld.sock\n`);
fs.writeFileSync(path.join(siteCPath, 'app', 'vendor', 'autoload.php'), '<?php // vendor');
fs.writeFileSync(path.join(siteCPath, 'app', 'composer.json'), '{"name":"acato/ortho"}');
fs.writeFileSync(path.join(siteCPath, 'app', 'sql', 'local.sql'), '-- dump CUSTOM-A');
fs.writeFileSync(path.join(siteCPath, 'conf', 'apache', 'site.conf.hbs'),
	`<VirtualHost>\n\tDocumentRoot "${siteCPath}/app/public_html"\n</VirtualHost>\n`);
fs.writeFileSync(path.join(siteCPath, 'logs', 'error.log'), 'MUST NOT TRANSFER');
fs.writeFileSync(path.join(siteCPath, 'mysqldata', 'ibdata1'), 'MUST NOT TRANSFER');
fs.writeFileSync(path.join(siteCPath, 'deploy-notes.txt'), 'root level file');
const siteCJson = {
	id: 'ccc333', name: 'Ortho Custom', domain: 'ortho.test', path: siteCPath,
	environment: 'custom',
	mysql: { database: 'local', user: 'root', password: 'root' },
	services: {
		php: { name: 'php', version: '8.2.23', role: 'php' },
		mysql: { name: 'mysql', version: '8.0.35', role: 'db' },
		apache: { name: 'apache', version: '2.4.43', role: 'http' },
		mailpit: { name: 'mailpit', version: '1.12.1' },
	},
};
const siteAJson = {
	id: 'aaa111', name: 'Flux Demo', domain: 'flux-demo.local', path: siteAPath,
	mysql: { database: 'local', user: 'root', password: 'root' },
	services: { php: { name: 'php', version: '8.2.1', role: 'php' }, mysql: { name: 'mysql', version: '8.0.35', role: 'db' } },
};
const emptySiteJson = { id: 'bbb222', name: 'Empty Site', domain: 'empty.local', path: path.join(TMP, 'machine-a', 'empty') };
fs.mkdirSync(path.join(emptySiteJson.path, 'app', 'public'), { recursive: true });

// Preferred-environment site (standard app/public layout) that nevertheless
// runs Apache — the common case Local would otherwise re-provision as nginx.
const siteDPath = path.join(TMP, 'machine-a', 'apache-pref');
makeSiteDir(siteDPath, 'FROM-MACHINE-A-APACHE');
const siteDJson = {
	id: 'ddd444', name: 'Apache Pref', domain: 'apache-pref.local', path: siteDPath,
	mysql: { database: 'local', user: 'root', password: 'root' },
	services: {
		php: { name: 'php', version: '8.3.1', role: 'php' },
		mysql: { name: 'mysql', version: '8.0.35', role: 'db' },
		apache: { name: 'apache', version: '2.4.43', role: 'http' },
	},
};

const logger = { info: () => {}, warn: (m) => console.log('  [warn]', m), error: (m) => console.log('  [error]', m), child: function () { return this; } };
const aSites = { aaa111: siteAJson, bbb222: emptySiteJson, ccc333: siteCJson, ddd444: siteDJson };
const cradleA = {
	localLogger: logger,
	siteData: {
		getSites: () => aSites,
		getSite: (id) => aSites[id] || null,
	},
	siteProcessManager: { getSiteStatus: () => 'halted' },
	siteDatabase: { dump: async () => { throw new Error('should not dump halted site'); } },
};

// ---------- fake destination machine B ----------

const machineB = path.join(TMP, 'machine-b');
fs.mkdirSync(machineB, { recursive: true });
const sqlCalls = [];
const bSites = {};
const cradleB = {
	localLogger: logger,
	siteData: {
		getSites: () => bSites,
		getSite: (id) => bSites[id] || null,
	},
	siteProcessManager: { getSiteStatus: () => 'running', start: async () => {}, restart: async () => {} },
	siteDatabase: { waitForDB: async () => true, dump: async () => {} },
	runSiteSQLCmd: async ({ query }) => { sqlCalls.push(query); return query.includes('@@SQL_MODE') ? '@@SQL_MODE\nONLY_FULL_GROUP_BY' : ''; },
	importSQLFile: async (site, file) => { sqlCalls.push(`IMPORT:${file}`); },
	changeSiteDomain: { changeSiteDomainToHost: async () => { sqlCalls.push('CHANGE_DOMAIN'); } },
	lastNewSiteInfo: null,
	addSite: {
		// Simulates Local: build site record, apply the filter, provision dirs, fire siteAdded.
		addSite: async ({ newSiteInfo }) => {
			cradleB.lastNewSiteInfo = newSiteInfo;
			// Mirror Local's getLocalSiteServices(): the web server defaults to
			// nginx and only switches when newSiteInfo.webServer is a compound
			// "name-version" string (getServiceSettingValueDetails splits on '-'
			// and drops it unless BOTH parts are present). This makes the stub
			// reject a bare "apache" exactly as Local does.
			const [wsName, wsVer] = String(newSiteInfo.webServer || '').split('-');
			const httpService = (wsName && wsVer)
				? { name: wsName, version: wsVer, role: 'http' }
				: { name: 'nginx', version: '1.26.1', role: 'http' };
			let site = {
				id: `new-${Object.keys(bSites).length}`,
				name: newSiteInfo.siteName,
				domain: newSiteInfo.siteDomain,
				path: newSiteInfo.sitePath,
				environment: newSiteInfo.environment,
				services: { http: httpService },
				mysql: { database: 'local', user: 'root', password: 'root' },
			};
			site = applyFilters('modifyAddSiteObjectBeforeCreation', site, newSiteInfo);
			bSites[site.id] = site;
			fs.mkdirSync(path.join(site.path, 'app', 'public'), { recursive: true });
			await doActions('siteAdded', site);
			return site;
		},
	},
};

// ---------- run ----------

(async () => {
	const { deriveKey } = require(path.join(ADDON, 'src/lib/auth.js'));
	const BeamServer = require(path.join(ADDON, 'src/lib/server.js'));
	const client = require(path.join(ADDON, 'src/lib/client.js'));
	const importer = require(path.join(ADDON, 'src/lib/importer.js'));

	importer.registerHooks(cradleB, logger);

	const key = deriveKey('purple-elephant-42');
	const wrongKey = deriveKey('wrong-code');

	const server = new BeamServer({ key, cradle: cradleA, logger, displayName: 'Machine A', version: '1.0.0' });
	const port = await server.listen();
	const peer = { host: '127.0.0.1', port, name: 'Machine A' };
	console.log(`1. server listening on ${port}`);

	// auth: wrong code must be rejected
	await assert.rejects(client.getJSON(peer, wrongKey, '/beam/v1/ping'), /shared code/i);
	console.log('2. wrong shared code rejected (401)');

	const ping = await client.getJSON(peer, key, '/beam/v1/ping');
	assert.strictEqual(ping.ok, true);
	assert.strictEqual(ping.sites, 4);
	const { sites } = await client.getJSON(peer, key, '/beam/v1/sites');
	assert.strictEqual(sites.length, 4);
	const remoteFlux = sites.find((s) => s.name === 'Flux Demo');
	assert.strictEqual(remoteFlux.php, '8.2.1');
	console.log('3. ping + site list OK:', sites.map((s) => `${s.name} [${s.status}]`).join(', '));

	// export of a never-dumped site must 409 with a helpful message
	await assert.rejects(client.getJSON(peer, key, '/beam/v1/export/bbb222'), /not running and has no saved database dump/);
	console.log('4. export of dump-less site refused with 409 guidance');

	// full pull: download → extract → import as new site
	const zipPath = path.join(machineB, 'dl', 'export.zip');
	fs.mkdirSync(path.dirname(zipPath), { recursive: true });
	const bytes = await client.downloadToFile(peer, key, '/beam/v1/export/aaa111', zipPath);
	assert.ok(bytes > 200, `zip too small: ${bytes}`);
	console.log(`5. downloaded export zip (${bytes} bytes)`);

	const extracted = await importer.extractExportZip(zipPath, () => {});
	assert.strictEqual(extracted.manifest.site.name, 'Flux Demo');
	assert.strictEqual(extracted.manifest.site.php.version, '8.2.1');
	assert.strictEqual(extracted.manifest.freshDump, false);
	assert.ok(fs.existsSync(path.join(extracted.extractedDir, 'local-site.json')));
	console.log('6. extracted; manifest + local-site.json OK');

	// monkey-patch defaultSitesDir target: sites land under most-common parent; none exist yet → ~/Local Sites.
	// For the test, pre-seed one site record so new sites land inside TMP.
	bSites.seed = { id: 'seed', name: 'Seed', domain: 'seed.local', path: path.join(machineB, 'seed-site') };
	fs.mkdirSync(bSites.seed.path, { recursive: true });

	const res1 = await importer.importExtracted(cradleB, logger, extracted, 'new', () => {});
	assert.strictEqual(res1.action, 'created');
	const created = res1.site;
	assert.ok(created.path.startsWith(machineB), `unexpected site path ${created.path}`);
	assert.strictEqual(
		fs.readFileSync(path.join(created.path, 'app', 'public', 'wp-content', 'marker.txt'), 'utf8'),
		'FROM-MACHINE-A');
	assert.ok(sqlCalls.some((q) => q.startsWith('IMPORT:')), 'importSQLFile not called');
	assert.ok(sqlCalls.includes('CHANGE_DOMAIN'), 'domain rewrite not called');
	assert.ok(sqlCalls.some((q) => q.includes("SQL_MODE='ONLY_FULL_GROUP_BY'")), 'SQL_MODE not restored');
	console.log(`7. imported as new site "${created.name}" at ${created.path}`);

	// symlinks stay relative links; hardlinks share an inode again
	const destContent = path.join(created.path, 'app', 'public', 'wp-content');
	const linkStat = fs.lstatSync(path.join(destContent, 'plugins-link'));
	assert.ok(linkStat.isSymbolicLink(), 'plugins-link is no longer a symlink');
	assert.strictEqual(fs.readlinkSync(path.join(destContent, 'plugins-link')), 'plugins');
	assert.strictEqual(
		fs.readFileSync(path.join(destContent, 'plugins-link', 'real-plugin', 'plugin.php'), 'utf8'),
		'<?php // real');
	assert.strictEqual(
		extracted.manifest.hardlinks['app/public/wp-content/uploads/original.txt'],
		'app/public/wp-content/uploads/linked.txt');
	const inoA = fs.statSync(path.join(destContent, 'uploads', 'original.txt')).ino;
	const inoB = fs.statSync(path.join(destContent, 'uploads', 'linked.txt')).ino;
	assert.strictEqual(inoA, inoB, 'hardlink pair not restored to one inode');
	assert.strictEqual(fs.readFileSync(path.join(destContent, 'uploads', 'linked.txt'), 'utf8'), 'same inode');
	console.log('7b. symlink survived as relative link; hardlink pair shares one inode again');

	// mode 'new' with existing site must refuse
	const extracted2 = await importer.extractExportZip(zipPath, () => {});
	await assert.rejects(importer.importExtracted(cradleB, logger, extracted2, 'new', () => {}), /already exists/);
	console.log('8. duplicate refused in default mode');

	// mode 'rename' creates "Flux Demo 2"
	const res2 = await importer.importExtracted(cradleB, logger, extracted2, 'rename', () => {});
	assert.strictEqual(res2.action, 'renamed');
	assert.strictEqual(res2.site.name, 'Flux Demo 2');
	assert.strictEqual(res2.site.domain, 'flux-demo-2.local');
	console.log(`9. rename mode -> "${res2.site.name}" (${res2.site.domain})`);

	// mode 'overwrite' replaces files in place (stale file must disappear)
	const stale = path.join(created.path, 'app', 'public', 'stale-file.txt');
	fs.writeFileSync(stale, 'should be deleted by overwrite');
	const extracted3 = await importer.extractExportZip(zipPath, () => {});
	const res3 = await importer.importExtracted(cradleB, logger, extracted3, 'overwrite', () => {});
	assert.strictEqual(res3.action, 'overwritten');
	assert.ok(!fs.existsSync(stale), 'stale file survived overwrite');
	assert.ok(fs.existsSync(path.join(created.path, 'app', 'public', 'index.php')));
	console.log('10. overwrite mode replaced files in place (stale file removed)');

	// custom-environment site (4ortho-style layout)
	const { sites: sites2 } = await client.getJSON(peer, key, '/beam/v1/sites');
	assert.strictEqual(sites2.length, 4);
	const zipPath2 = path.join(machineB, 'dl2', 'export.zip');
	fs.mkdirSync(path.dirname(zipPath2), { recursive: true });
	await client.downloadToFile(peer, key, '/beam/v1/export/ccc333', zipPath2);
	const extractedC = await importer.extractExportZip(zipPath2, () => {});
	const cm = extractedC.manifest.site;
	assert.strictEqual(cm.sourceWebRootName, 'public_html');
	assert.strictEqual(cm.environment, 'custom');
	assert.strictEqual(cm.webServer.name, 'apache');
	assert.strictEqual(cm.sourcePath, siteCPath);
	assert.ok(!fs.existsSync(path.join(extractedC.extractedDir, 'logs')), 'logs/ leaked into export');
	assert.ok(!fs.existsSync(path.join(extractedC.extractedDir, 'mysqldata', 'ibdata1')), 'mysqldata leaked into export');
	assert.ok(fs.existsSync(path.join(extractedC.extractedDir, 'conf', 'apache', 'site.conf.hbs')), 'conf missing from export');
	assert.ok(fs.existsSync(path.join(extractedC.extractedDir, 'deploy-notes.txt')), 'root-level file missing from export');
	console.log('12. custom-layout export: public_html + conf + root files in, logs/mysqldata out');

	const resC = await importer.importExtracted(cradleB, logger, extractedC, 'new', () => {});
	assert.strictEqual(resC.action, 'created');
	const cDest = resC.site.path;
	assert.strictEqual(cradleB.lastNewSiteInfo.environment, 'custom');
	assert.strictEqual(cradleB.lastNewSiteInfo.webServer, 'apache-2.4.43');
	assert.strictEqual(cradleB.lastNewSiteInfo.phpVersion, '8.2.23');
	assert.strictEqual(resC.site.services.http.name, 'apache', 'imported site did not land on Apache');
	assert.strictEqual(
		fs.readFileSync(path.join(cDest, 'app', 'public_html', 'wp-content', 'marker.txt'), 'utf8'), 'CUSTOM-A');
	assert.ok(fs.existsSync(path.join(cDest, 'app', 'vendor', 'autoload.php')), 'vendor/ not restored');
	const pubLink = fs.lstatSync(path.join(cDest, 'app', 'public'));
	assert.ok(pubLink.isSymbolicLink(), 'symlinked app/public not restored (placeholder dir not cleared)');
	assert.strictEqual(fs.readlinkSync(path.join(cDest, 'app', 'public')), 'public_html', 'app/public link target wrong');
	assert.ok(fs.existsSync(path.join(cDest, 'deploy-notes.txt')), 'root-level file not restored');
	const confOut = fs.readFileSync(path.join(cDest, 'conf', 'apache', 'site.conf.hbs'), 'utf8');
	assert.ok(confOut.includes(`${cDest}/app/public_html`), 'conf DocumentRoot not rewritten to destination path');
	assert.ok(!confOut.includes(siteCPath), 'conf still references source path');
	console.log(`13. custom-layout import: env custom/apache/php 8.2.23, public_html + vendor restored, conf rewritten to ${cDest}`);

	const envOut = fs.readFileSync(path.join(cDest, 'app', 'public_html', '.env'), 'utf8');
	assert.ok(envOut.includes('DB_HOST="localhost"'), `.env socket not stripped: ${envOut}`);
	assert.ok(envOut.includes('DB_SOCKET=/keep/this/mysqld.sock'), 'standalone DB_SOCKET line was wrongly touched');
	console.log('15. .env DB_HOST socket path rewritten to plain localhost (standalone DB_SOCKET untouched)');

	// preferred-environment site running Apache: must be provisioned as a
	// custom environment so Local keeps Apache instead of defaulting to nginx.
	const zipPathD = path.join(machineB, 'dl3', 'export.zip');
	fs.mkdirSync(path.dirname(zipPathD), { recursive: true });
	await client.downloadToFile(peer, key, '/beam/v1/export/ddd444', zipPathD);
	const extractedPref = await importer.extractExportZip(zipPathD, () => {});
	assert.notStrictEqual(extractedPref.manifest.site.environment, 'custom');
	assert.strictEqual(extractedPref.manifest.site.webServer.name, 'apache');
	const resPref = await importer.importExtracted(cradleB, logger, extractedPref, 'new', () => {});
	assert.strictEqual(resPref.action, 'created');
	assert.strictEqual(cradleB.lastNewSiteInfo.environment, 'custom');
	assert.strictEqual(cradleB.lastNewSiteInfo.webServer, 'apache-2.4.43');
	assert.strictEqual(cradleB.lastNewSiteInfo.phpVersion, '8.3.1');
	assert.strictEqual(resPref.site.services.http.name, 'apache', 'preferred-env site did not land on Apache');
	console.log('16. preferred-env Apache site promoted to custom/apache-2.4.43/php 8.3.1 on import');

	// failed provisioning: Local rolls the site back -> our folder cleanup must kick in
	const extractedD = await importer.extractExportZip(zipPath2, () => {});
	const realAddSite = cradleB.addSite.addSite;
	cradleB.addSite.addSite = async ({ newSiteInfo }) => {
		// simulate Local: dirs created, then provisioning explodes and the record is rolled back
		fs.mkdirSync(path.join(newSiteInfo.sitePath, 'app', 'public'), { recursive: true });
		throw new Error("EEXIST: file already exists, mkdir '%%router.runPath%%/nginx/conf/local-router-error-pages'");
	};
	await assert.rejects(importer.importExtracted(cradleB, logger, extractedD, 'rename', () => {}), /EEXIST/);
	cradleB.addSite.addSite = realAddSite;
	const orphans = fs.readdirSync(machineB).filter((d) => d.startsWith('ortho-custom-'));
	assert.strictEqual(orphans.length, 0, `orphan folder left behind: ${orphans.join(', ')}`);
	console.log('14. failed creation: orphaned site folder cleaned up');

	// concurrent export of the SAME running site must not race on the dump.
	// Reproduces Local's dump(): write a FIXED <site>/app/sql/local.sql.tmp,
	// then rename it onto the caller's target. Without per-site serialization,
	// two overlapping dumps clobber the shared .tmp and the second renames a
	// vanished file -> ENOENT. The exporter's dump lock must serialize them.
	const { writeExportArchive } = require(path.join(ADDON, 'src/lib/exporter.js'));
	const runningPath = path.join(TMP, 'machine-a', 'running');
	makeSiteDir(runningPath, 'RUNNING');
	const runningJson = {
		id: 'run555', name: 'Running Site', domain: 'running.local', path: runningPath,
		mysql: { database: 'local', user: 'root', password: 'root' },
		services: { php: { name: 'php', version: '8.2.1', role: 'php' } },
	};
	let dumpOverlap = 0; let dumpsInFlight = 0;
	const racyCradle = {
		localLogger: logger,
		siteProcessManager: { getSiteStatus: () => 'running' },
		siteDatabase: {
			dump: async (site, target) => {
				dumpsInFlight += 1;
				if (dumpsInFlight > 1) { dumpOverlap += 1; }
				const fixedTmp = path.join(site.path, 'app', 'sql', 'local.sql.tmp');
				fs.writeFileSync(fixedTmp, `-- dump for ${path.basename(target)}`);
				await new Promise((r) => setTimeout(r, 15)); // let a peer interleave
				fs.renameSync(fixedTmp, target); // ENOENT here if another dump moved it
				dumpsInFlight -= 1;
			},
		},
	};
	const outA = path.join(machineB, 'concur', 'a.zip');
	const outB = path.join(machineB, 'concur', 'b.zip');
	fs.mkdirSync(path.dirname(outA), { recursive: true });
	const streamExport = (out) => new Promise((resolve, reject) => {
		const ws = fs.createWriteStream(out);
		writeExportArchive(racyCradle, logger, runningJson, ws).then(resolve, reject);
	});
	const [rA, rB] = await Promise.allSettled([streamExport(outA), streamExport(outB)]);
	assert.strictEqual(rA.status, 'fulfilled', `export A failed: ${rA.reason && rA.reason.message}`);
	assert.strictEqual(rB.status, 'fulfilled', `export B failed: ${rB.reason && rB.reason.message}`);
	assert.ok(fs.statSync(outA).size > 0 && fs.statSync(outB).size > 0, 'concurrent export produced an empty zip');
	assert.strictEqual(dumpOverlap, 0, 'dumps of the same site ran concurrently — per-site lock not holding');
	console.log('17. concurrent export of one running site serialized its dumps (no local.sql.tmp race)');

	server.close();

	// discovery smoke test (may be blocked by sandbox/network — non-fatal)
	try {
		const Discovery = require(path.join(ADDON, 'src/lib/discovery.js'));
		const mk = (id) => new Discovery({ fp: 'fp1234', instanceId: id, displayName: `peer-${id}`, port: 40000, logger });
		const d1 = mk('11111111'); const d2 = mk('22222222');
		d1.start(); d2.start();
		await new Promise((r) => setTimeout(r, 4000));
		const found = d1.peers().some((p) => p.id === '22222222') && d2.peers().some((p) => p.id === '11111111');
		d1.stop(); d2.stop();
		console.log(found ? '11. mDNS discovery: peers found each other'
			: '11. mDNS discovery: no peers seen (likely sandbox multicast block) — verify on real network');
	} catch (err) {
		console.log(`11. mDNS discovery skipped: ${err.message}`);
	}

	console.log('\nALL TESTS PASSED');
	process.exit(0);
})().catch((err) => {
	console.error('\nTEST FAILED:', err);
	process.exit(1);
});
