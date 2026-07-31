'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Import pipeline: takes a Site Beam export zip (from a LAN peer or croc) and
 * turns it into a working local site.
 *
 * New sites ride Local's own creation flow (the same pattern Local's Cloud
 * Backups add-on uses): addSite with installWP: false, then a `siteAdded`
 * hook restores the whole site folder + database and rewrites URLs to the new
 * host. Custom-environment sites (e.g. web root app/public_html) are created
 * as custom environments with the source's web server / PHP version, and the
 * source's conf/ templates are restored with absolute paths rewritten to the
 * destination site folder.
 *
 * Conflict modes when a site with the same name/domain already exists:
 *   'new'       refuse (default)
 *   'rename'    import as "<name> 2" with a fresh domain/path
 *   'overwrite' replace the existing site's files + database in place
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const extractZip = require('extract-zip');
const Local = require('@getflywheel/local');
const LocalMain = require('@getflywheel/local/main');

const { resolveWebRoot } = require('./exporter');

const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

// Zip entries that are Site Beam metadata or restored via a dedicated path,
// not plain-copied into the destination site folder.
const SPECIAL_ROOT_ENTRIES = ['beam-manifest.json', 'local-site.json', 'conf'];

const pendingImports = new Map();

function toSite(siteJson) {
	return siteJson instanceof Local.Site ? siteJson : new Local.Site(siteJson);
}

function nicename(name) {
	if (typeof LocalMain.formatSiteNicename === 'function') {
		try {
			return LocalMain.formatSiteNicename(name);
		} catch (err) { /* fall through */ }
	}
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function allSites(cradle) {
	return Object.values(cradle.siteData.getSites() || {});
}

function findExisting(cradle, name, domain) {
	const n = String(name || '').trim().toLowerCase();
	const d = String(domain || '').trim().toLowerCase();
	return allSites(cradle).find((s) =>
		(s.name || '').trim().toLowerCase() === n || (d && (s.domain || '').toLowerCase() === d)
	) || null;
}

/*
 * Register the two hooks that finish a Site-Beam import once Local has
 * created and provisioned the empty site. Called once at add-on startup.
 */
function registerHooks(cradle, logger) {
	LocalMain.HooksMain.addFilter('modifyAddSiteObjectBeforeCreation', (site, newSiteInfo) => {
		if (newSiteInfo && newSiteInfo.siteBeam) {
			site.siteBeam = newSiteInfo.siteBeam;
		}
		return site;
	});

	// Only copy FILES here: this hook runs in the middle of Local's own
	// creation/provisioning flow, and touching services (site restart, router
	// reconfiguration via domain changes) concurrently races Local's router
	// setup (observed as EEXIST on router.runPath/nginx/conf). The database
	// import and URL rewrite happen after addSite() has fully completed.
	LocalMain.HooksMain.addAction('siteAdded', async (site) => {
		const meta = site && site.siteBeam;
		if (!meta || !pendingImports.has(meta.importId)) {
			return;
		}
		const job = pendingImports.get(meta.importId);
		pendingImports.delete(meta.importId);
		try {
			await copySiteFiles(cradle, logger, site, job, { freshSite: true });
			job.resolve(site);
		} catch (err) {
			logger.error(`Site Beam: file restore into new site failed: ${err.message}`);
			try {
				LocalMain.sendIPCEvent('updateSiteStatus', site.id, 'halted');
			} catch (ipcErr) { /* UI update is best-effort */ }
			job.reject(err);
		}
	});
}

/*
 * Recursively rewrite absolute source paths inside restored conf templates so
 * DocumentRoot etc. point at the destination site folder.
 */
function rewritePathsInDir(dir, from, to, logger) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			rewritePathsInDir(full, from, to, logger);
		} else if (entry.isFile()) {
			try {
				if (fs.statSync(full).size > 1024 * 1024) {
					continue;
				}
				const content = fs.readFileSync(full, 'utf8');
				if (content.includes(from)) {
					fs.writeFileSync(full, content.split(from).join(to));
				}
			} catch (err) {
				logger.warn(`Site Beam: could not rewrite paths in ${full}: ${err.message}`);
			}
		}
	}
}

/*
 * Configs often pin the DB host to the SOURCE machine's per-site socket
 * (e.g. .env with DB_HOST="localhost:/Users/x/Library/.../run/<id>/mysql/
 * mysqld.sock") — a path that cannot exist on the destination. Plain
 * "localhost" works on every Local site because the per-site php.ini sets the
 * default socket. Rewrite host:socket combos; standalone socket variables are
 * left untouched.
 */
// Note: socket paths may contain spaces ("Application Support"), so only
// quotes/newlines terminate the match, non-greedily up to mysqld.sock.
const DB_SOCKET_RE = /(localhost|127\.0\.0\.1):[^"'\r\n]*?mysqld\.sock/g;

function fixSocketReferences(destRoot, webRootName, logger) {
	const appDir = path.join(destRoot, 'app');
	const webRoot = path.join(appDir, webRootName);
	const candidates = [];
	for (const dir of [destRoot, appDir, webRoot]) {
		try {
			for (const entry of fs.readdirSync(dir)) {
				if (entry === '.env' || entry.startsWith('.env.')) {
					candidates.push(path.join(dir, entry));
				}
			}
		} catch (err) { /* dir absent */ }
	}
	candidates.push(path.join(webRoot, 'wp-config.php'), path.join(appDir, 'wp-config.php'));
	for (const file of candidates) {
		try {
			if (!fs.existsSync(file) || fs.statSync(file).size > 1024 * 1024) {
				continue;
			}
			const content = fs.readFileSync(file, 'utf8');
			if (!content.includes('mysqld.sock')) {
				continue;
			}
			const fixed = content.replace(DB_SOCKET_RE, 'localhost');
			if (fixed !== content) {
				fs.writeFileSync(file, fixed);
				logger.warn(`Site Beam: rewrote machine-specific DB socket in ${file} to "localhost"`);
			}
		} catch (err) {
			logger.warn(`Site Beam: could not check ${file} for socket paths: ${err.message}`);
		}
	}
}

/*
 * Restores hardlinks recorded in the manifest ({ duplicate: canonical },
 * posix paths relative to the site root). The zip stores them as independent
 * copies, so any failure here just leaves a working copy in place. Paths are
 * confined to destRoot — the manifest arrives inside the zip and is untrusted.
 */
function restoreHardlinks(destRoot, hardlinks, logger) {
	const inRoot = (rel) => {
		const abs = path.resolve(destRoot, rel);
		return abs.startsWith(destRoot + path.sep) ? abs : null;
	};
	for (const [dup, canonical] of Object.entries(hardlinks || {})) {
		const dupAbs = inRoot(dup);
		const canonicalAbs = inRoot(canonical);
		if (!dupAbs || !canonicalAbs || dupAbs === canonicalAbs) {
			continue;
		}
		try {
			if (!fs.lstatSync(canonicalAbs).isFile()) {
				continue;
			}
			fs.rmSync(dupAbs, { force: true });
			fs.linkSync(canonicalAbs, dupAbs);
		} catch (err) {
			logger.warn(`Site Beam: could not restore hardlink ${dup} -> ${canonical}: ${err.message}`);
		}
	}
}

/*
 * Local scaffolds a fresh site with a real, empty default web root (app/public).
 * When the SOURCE stored that path (or any path) as a symlink — dev setups
 * commonly symlink app/public -> app/public_html — fs.cp refuses to overwrite
 * the real placeholder directory with a symlink (ERR_FS_CP_NON_DIR_TO_DIR) and
 * aborts the entire copy, leaving app/ half-populated. Walk the export for
 * symlinks and remove any destination path that is currently a real directory,
 * so the copy can recreate the link in its place. Only real dirs are recursed;
 * symlinks in the export are never followed.
 */
function clearSymlinkPlaceholders(extractedDir, destRoot, logger) {
	const walk = (rel) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(extractedDir, rel), { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (const ent of entries) {
			const childRel = rel ? path.join(rel, ent.name) : ent.name;
			if (ent.isSymbolicLink()) {
				const destPath = path.join(destRoot, childRel);
				try {
					if (fs.lstatSync(destPath).isDirectory()) {
						fs.rmSync(destPath, { recursive: true, force: true });
						logger.info(`Site Beam: cleared placeholder directory ${childRel} so the exported symlink can be restored`);
					}
				} catch (err) { /* nothing at destPath — the copy will create the link */ }
			} else if (ent.isDirectory()) {
				walk(childRel);
			}
		}
	};
	walk('');
}

/*
 * Copies the exported site folder into an (already created) site.
 * No service interaction — safe to run while Local's creation flow is active.
 */
async function copySiteFiles(cradle, logger, siteJson, job, { freshSite }) {
	const site = toSite(siteJson);
	const progress = job.onProgress || (() => {});
	const send = LocalMain.sendIPCEvent;
	const manifestSite = (job.manifest && job.manifest.site) || {};

	send('updateSiteStatus', site.id, 'provisioning');
	send('updateSiteMessage', site.id, 'Site Beam: copying site files…');
	progress('files', `Copying files into "${site.name}"…`);

	const destRoot = LocalMain.formatHomePath(site.path);
	const webRootName = manifestSite.sourceWebRootName || 'public';
	const extractedWebRoot = path.join(job.extractedDir, 'app', webRootName);
	if (!fs.existsSync(extractedWebRoot)) {
		throw new Error(`Export is missing app/${webRootName} — not a Site Beam / Local export zip.`);
	}
	if (!freshSite) {
		// True overwrite: clear the existing web root first so files deleted
		// on the source don't linger on the destination.
		try {
			fs.rmSync(resolveWebRoot(siteJson), { recursive: true, force: true });
		} catch (err) {
			logger.warn(`Site Beam: could not clear existing web root: ${err.message}`);
		}
	}
	fs.mkdirSync(destRoot, { recursive: true });
	// Remove Local's real placeholder dirs (e.g. the scaffolded app/public) where
	// the export stored a symlink, so fs.cp can recreate the link instead of
	// aborting on ERR_FS_CP_NON_DIR_TO_DIR.
	clearSymlinkPlaceholders(job.extractedDir, destRoot, logger);
	// The whole exported site folder, real layout preserved (vendor/,
	// composer.json, root-level files, …). conf/ is handled separately below.
	for (const entry of fs.readdirSync(job.extractedDir)) {
		if (SPECIAL_ROOT_ENTRIES.includes(entry)) {
			continue;
		}
		// verbatimSymlinks keeps link targets as stored (relative links stay
		// relative) — the default rewrites them to absolute paths into the
		// temporary extraction dir, which is deleted after import.
		await fs.promises.cp(path.join(job.extractedDir, entry), path.join(destRoot, entry), { recursive: true, force: true, verbatimSymlinks: true });
	}

	// Custom environments: restore conf templates (DocumentRoot app/public_html
	// etc.) with source paths rewritten. Only for fresh sites — an overwritten
	// site keeps its own, already-working conf.
	const extractedConf = path.join(job.extractedDir, 'conf');
	if (freshSite && manifestSite.environment === 'custom' && fs.existsSync(extractedConf)) {
		progress('conf', 'Restoring custom environment configuration…');
		const destConf = path.join(destRoot, 'conf');
		await fs.promises.cp(extractedConf, destConf, { recursive: true, force: true, verbatimSymlinks: true });
		if (manifestSite.sourcePath && manifestSite.sourcePath !== destRoot) {
			rewritePathsInDir(destConf, manifestSite.sourcePath, destRoot, logger);
		}
	}

	restoreHardlinks(destRoot, job.manifest && job.manifest.hardlinks, logger);
	fixSocketReferences(destRoot, webRootName, logger);
}

/*
 * Imports the database and rewrites URLs. Touches services (DB, domain,
 * restart), so for fresh sites this must only run AFTER addSite() completed.
 */
async function finishRestore(cradle, logger, siteJson, job, { freshSite }) {
	const site = toSite(siteJson);
	const { siteDatabase, runSiteSQLCmd, importSQLFile, changeSiteDomain, siteProcessManager } = cradle;
	const progress = job.onProgress || (() => {});
	const send = LocalMain.sendIPCEvent;

	send('updateSiteMessage', site.id, 'Site Beam: importing database…');
	progress('database', `Importing database for "${site.name}"…`);

	if (!freshSite) {
		const status = await Promise.resolve(siteProcessManager.getSiteStatus(site)).catch(() => 'unknown');
		if (status !== 'running') {
			await siteProcessManager.start(site);
		}
	}
	await siteDatabase.waitForDB(site);

	const sqlFile = path.join(job.extractedDir, 'app', 'sql', 'local.sql');
	if (!fs.existsSync(sqlFile)) {
		throw new Error('Export is missing app/sql/local.sql — no database to import.');
	}
	let dbName = (siteJson.mysql && siteJson.mysql.database) || 'local';
	if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
		dbName = 'local';
	}
	const rawMode = String(await runSiteSQLCmd({ site, query: 'SELECT @@SQL_MODE;' }) || '');
	const previousSqlMode = rawMode.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('@@'))
		.pop() || '';
	await runSiteSQLCmd({ site, query: "SET GLOBAL SQL_MODE='NO_AUTO_VALUE_ON_ZERO';" });
	await runSiteSQLCmd({ site, query: `SET names 'utf8'; DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE IF NOT EXISTS ${dbName};` });
	await importSQLFile(site, sqlFile);
	if (previousSqlMode) {
		await runSiteSQLCmd({ site, query: `SET GLOBAL SQL_MODE='${previousSqlMode}';` });
	}

	send('updateSiteMessage', site.id, 'Site Beam: updating URLs…');
	progress('domain', `Rewriting URLs to ${site.host || site.domain}…`);
	try {
		await changeSiteDomain.changeSiteDomainToHost(site);
	} catch (err) {
		logger.warn(`Site Beam: changeSiteDomainToHost failed (site should still work if domains match): ${err.message}`);
	}
	try {
		await siteProcessManager.restart(site);
	} catch (err) {
		logger.warn(`Site Beam: restart after import failed: ${err.message}`);
	}
	send('updateSiteStatus', site.id, 'running');
}

/*
 * Full restore into an existing site (overwrite mode) — no creation flow is
 * running concurrently, so files + database can go in one sequence.
 */
async function restoreIntoSite(cradle, logger, siteJson, job, opts) {
	await copySiteFiles(cradle, logger, siteJson, job, opts);
	await finishRestore(cradle, logger, siteJson, job, opts);
}

function uniqueNaming(cradle, baseName) {
	const sites = allSites(cradle);
	const names = new Set(sites.map((s) => (s.name || '').trim().toLowerCase()));
	const domains = new Set(sites.map((s) => (s.domain || '').toLowerCase()));
	for (let i = 2; i < 100; i++) {
		const name = `${baseName} ${i}`;
		const slug = nicename(name);
		const domain = `${slug}.local`;
		if (!names.has(name.toLowerCase()) && !domains.has(domain)) {
			return { name, slug, domain };
		}
	}
	const slug = `${nicename(baseName)}-${Date.now()}`;
	return { name: `${baseName} ${Date.now()}`, slug, domain: `${slug}.local` };
}

function defaultSitesDir(cradle) {
	// Prefer the directory most of the existing sites live in; fall back to
	// Local's stock "~/Local Sites".
	try {
		const counts = {};
		for (const s of allSites(cradle)) {
			const parent = path.dirname(LocalMain.formatHomePath(s.path || ''));
			if (parent && parent !== '.' && parent !== path.sep) {
				counts[parent] = (counts[parent] || 0) + 1;
			}
		}
		const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
		if (best && fs.existsSync(best[0])) {
			return best[0];
		}
	} catch (err) { /* fall back */ }
	return path.join(os.homedir(), 'Local Sites');
}

function uniqueSitePath(baseDir, slug) {
	let candidate = path.join(baseDir, slug);
	let i = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(baseDir, `${slug}-${i}`);
		i++;
	}
	return candidate;
}

async function extractExportZip(zipPath, onProgress) {
	(onProgress || (() => {}))('extracting', 'Extracting export…');
	const extractedDir = path.join(path.dirname(zipPath), 'extracted');
	// A leftover from a previous extraction breaks re-imports: files overwrite
	// fine, but fs.symlink EEXISTs on already-present links.
	fs.rmSync(extractedDir, { recursive: true, force: true });
	await extractZip(zipPath, { dir: extractedDir });
	let manifest = null;
	const manifestPath = path.join(extractedDir, 'beam-manifest.json');
	const siteJsonPath = path.join(extractedDir, 'local-site.json');
	if (fs.existsSync(manifestPath)) {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} else if (fs.existsSync(siteJsonPath)) {
		// Plain Local export zip (not made by Site Beam) — synthesise a manifest.
		const siteJson = JSON.parse(fs.readFileSync(siteJsonPath, 'utf8'));
		manifest = {
			beamFormat: 0,
			site: {
				name: siteJson.name,
				domain: siteJson.domain,
				multiSite: siteJson.multiSite || false,
				mysqlCredentials: siteJson.mysql || null,
			},
		};
	} else {
		throw new Error('Archive has no beam-manifest.json or local-site.json — not a Site Beam / Local export.');
	}
	return { extractedDir, manifest };
}

/*
 * Import an extracted export. mode: 'new' | 'rename' | 'overwrite'.
 * Resolves with { site, action } when the site is fully restored.
 */
async function importExtracted(cradle, logger, { extractedDir, manifest }, mode, onProgress) {
	const progress = onProgress || (() => {});
	const manifestSite = manifest.site || {};
	const sourceName = manifestSite.name || 'Imported site';
	const sourceDomain = manifestSite.domain;
	const existing = findExisting(cradle, sourceName, sourceDomain);

	if (existing && mode === 'new') {
		const error = new Error(`"${existing.name}" already exists on this machine. Choose rename or overwrite to transfer anyway.`);
		error.code = 'SITE_EXISTS';
		throw error;
	}

	if (existing && mode === 'overwrite') {
		progress('overwriting', `Overwriting "${existing.name}"…`);
		const job = {
			extractedDir,
			manifest,
			onProgress: progress,
			resolve: () => {},
			reject: () => {},
		};
		await restoreIntoSite(cradle, logger, existing, job, { freshSite: false });
		return { site: existing, action: 'overwritten' };
	}

	// Fresh site — possibly renamed.
	let targetName = sourceName;
	let targetDomain = sourceDomain || `${nicename(sourceName)}.local`;
	let targetSlug = nicename(sourceName);
	if (existing && mode === 'rename') {
		({ name: targetName, slug: targetSlug, domain: targetDomain } = uniqueNaming(cradle, sourceName));
	}
	const sitePath = uniqueSitePath(defaultSitesDir(cradle), targetSlug);

	const importId = crypto.randomBytes(8).toString('hex');
	const completion = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingImports.delete(importId);
			reject(new Error('Timed out waiting for Local to create the site (30 min).'));
		}, IMPORT_TIMEOUT_MS);
		pendingImports.set(importId, {
			extractedDir,
			manifest,
			onProgress: progress,
			resolve: (site) => { clearTimeout(timer); resolve(site); },
			reject: (err) => { clearTimeout(timer); reject(err); },
		});
	});

	progress('creating', `Creating "${targetName}" in Local…`);
	if (!cradle.addSite || typeof cradle.addSite.addSite !== 'function') {
		pendingImports.delete(importId);
		throw new Error('This Local version does not expose the addSite service; cannot create the site programmatically. The downloaded zip can be dragged into Local manually.');
	}
	const newSiteInfo = {
		siteName: targetName,
		sitePath,
		siteDomain: targetDomain,
		multiSite: manifestSite.multiSite || false,
		siteBeam: { importId },
	};
	// Reproduce the source's web server and PHP version. Local's "preferred"
	// environment forces default services (nginx), silently dropping a source
	// that ran Apache — so provision a custom environment whenever the source
	// was already custom OR used a non-default web server. Custom conf/
	// templates are still keyed off the recorded manifestSite.environment
	// (see finishRestore), so this promotion does not trigger a conf restore;
	// Local generates fresh conf for the chosen web server.
	const web = manifestSite.webServer;
	const sourceWebServer = web && web.name;
	if (manifestSite.environment === 'custom' || (sourceWebServer && sourceWebServer !== 'nginx')) {
		newSiteInfo.environment = 'custom';
		if (manifestSite.php && manifestSite.php.version) {
			newSiteInfo.phpVersion = manifestSite.php.version;
		}
		// Local builds the site's services from newSiteInfo via
		// LightningServiceSharedUtils.getLocalSiteServices(), which parses
		// `webServer` with getServiceSettingValueDetails() — it splits the value
		// on '-' into { serviceName, binVersion } and DROPS it entirely unless
		// BOTH parts are present. A bare "apache" therefore has no binVersion and
		// is silently ignored, leaving the preferred default (nginx). Pass the
		// compound "name-version" form (e.g. "apache-2.4.43") so it actually
		// takes. phpVersion above is used as-is (raw version), not split.
		if (sourceWebServer && web.version) {
			newSiteInfo.webServer = `${sourceWebServer}-${web.version}`;
		}
	}
	let site = null;
	try {
		await cradle.addSite.addSite({
			newSiteInfo,
			wpCredentials: {
				adminUsername: 'admin',
				adminPassword: crypto.randomBytes(9).toString('base64url'),
				adminEmail: 'admin@example.com',
			},
			goToSite: true,
			installWP: false,
		});

		// Files are in place and Local's creation flow is fully finished — now
		// the service-touching part (database import, URL rewrite, restart)
		// can run without racing Local's provisioner/router.
		site = await completion;
		await finishRestore(cradle, logger, site, { extractedDir, manifest, onProgress: progress }, { freshSite: true });
	} catch (err) {
		pendingImports.delete(importId);
		if (site) {
			logger.error(`Site Beam: restore failed: ${err.message}`);
			try {
				LocalMain.sendIPCEvent('updateSiteStatus', site.id, 'halted');
			} catch (ipcErr) { /* UI update is best-effort */ }
		}
		// If Local rolled the site record back after a failed provision, don't
		// leave a half-copied orphan folder behind: sitePath was chosen by us
		// this run and verified non-existent beforehand, so removing it only
		// ever touches files this transfer created.
		try {
			const stillRegistered = allSites(cradle).some((s) =>
				(site && s.id === site.id) || LocalMain.formatHomePath(s.path || '') === sitePath);
			if (!stillRegistered && fs.existsSync(sitePath)) {
				fs.rmSync(sitePath, { recursive: true, force: true });
				logger.warn(`Site Beam: cleaned up orphaned site folder ${sitePath} after failed import`);
			}
		} catch (cleanupErr) {
			logger.warn(`Site Beam: could not clean up ${sitePath}: ${cleanupErr.message}`);
		}
		throw err;
	}
	return { site, action: existing ? 'renamed' : 'created' };
}

async function importZipFile(cradle, logger, zipPath, mode, onProgress) {
	const extracted = await extractExportZip(zipPath, onProgress);
	return importExtracted(cradle, logger, extracted, mode, onProgress);
}

module.exports = {
	registerHooks,
	findExisting,
	importExtracted,
	importZipFile,
	extractExportZip,
};
