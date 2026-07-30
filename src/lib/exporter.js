'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Builds a site export as a zip stream containing the ENTIRE site folder,
 * preserving its real layout (custom environments may serve app/public_html
 * or similar instead of Local's default app/public):
 *
 *   app/**               everything, including the web root under its real
 *                        name, vendor/, composer.json, … (except app/sql)
 *   conf/**              web server / php / mysql conf templates — needed to
 *                        reproduce custom environments on the destination
 *   <other root files>   any other files/dirs in the site folder
 *   app/sql/local.sql    fresh, portable database dump (replaces app/sql)
 *   local-site.json      the site's record from sites.json
 *   beam-manifest.json   Site Beam metadata (layout, environment, versions)
 *
 * Excluded: mysqldata/ (binary, MySQL-version-specific — the SQL dump
 * replaces it) and logs/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const archiver = require('archiver');
const Local = require('@getflywheel/local');
const LocalMain = require('@getflywheel/local/main');

const BEAM_FORMAT = 2;

const EXPORT_IGNORE = ['mysqldata', 'mysqldata/**', 'logs', 'logs/**', 'app/sql', 'app/sql/**'];

function toSite(siteJson) {
	return siteJson instanceof Local.Site ? siteJson : new Local.Site(siteJson);
}

/*
 * Finds the site's real web root. Local's default is <site>/app/public, but
 * custom environments often serve another folder (e.g. app/public_html) — the
 * truth lives in the web server conf template, so check that first.
 */
function resolveWebRoot(siteJson) {
	const site = toSite(siteJson);
	const sitePath = LocalMain.formatHomePath(site.path);
	const appDir = path.join(sitePath, 'app');
	const tried = [];

	const confSources = [
		[path.join(sitePath, 'conf', 'apache', 'site.conf.hbs'), /DocumentRoot\s+"?([^"\r\n]+?)"?\s*$/im],
		[path.join(sitePath, 'conf', 'nginx', 'site.conf.hbs'), /^\s*root\s+"?([^";\s]+)"?\s*;/im],
	];
	for (const [file, pattern] of confSources) {
		try {
			if (fs.existsSync(file)) {
				const match = fs.readFileSync(file, 'utf8').match(pattern);
				if (match) {
					const confRoot = LocalMain.formatHomePath(match[1].trim());
					if (fs.existsSync(confRoot)) {
						return confRoot;
					}
					tried.push(confRoot);
				}
			}
		} catch (err) { /* unreadable conf — keep looking */ }
	}

	const standard = LocalMain.formatHomePath(site.paths.webRoot);
	if (fs.existsSync(standard)) {
		return standard;
	}
	tried.push(standard);

	for (const name of ['public_html', 'public', 'htdocs', 'web', 'wordpress']) {
		const candidate = path.join(appDir, name);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	const error = new Error(`Could not find the web root for "${site.name}" (tried: ${tried.join(', ')}).`);
	error.statusCode = 500;
	throw error;
}

function serviceVersion(siteJson, role, fallbackKey) {
	const services = siteJson.services || {};
	for (const svc of Object.values(services)) {
		if (svc && svc.role === role) {
			return { name: svc.name, version: svc.version };
		}
	}
	if (siteJson[fallbackKey]) {
		return { name: role, version: siteJson[fallbackKey] };
	}
	return null;
}

function buildManifest(siteJson, freshDump) {
	return {
		beamFormat: BEAM_FORMAT,
		exportedAt: new Date().toISOString(),
		freshDump,
		site: {
			name: siteJson.name,
			domain: siteJson.domain,
			multiSite: siteJson.multiSite || false,
			environment: siteJson.environment || null,
			localVersion: siteJson.localVersion || null,
			mysqlCredentials: siteJson.mysql || null,
			php: serviceVersion(siteJson, 'php', 'phpVersion'),
			database: serviceVersion(siteJson, 'db', 'mysqlVersion'),
			webServer: serviceVersion(siteJson, 'http', 'webServer'),
		},
	};
}

/*
 * ZIP has no hardlink concept, so hardlinked files land in the archive as
 * independent copies. This walk records which files shared an inode on the
 * source, as { duplicatePath: canonicalPath } (posix paths relative to
 * siteRoot), so the importer can restore the links after copying. Symlinks
 * are never followed. A hardlink whose other name lives outside the site
 * root can't be grouped and stays a plain copy — intentionally, same
 * policy as symlinks.
 */
function detectHardlinks(siteRoot, logger) {
	const skipDirs = new Set(EXPORT_IGNORE.filter((p) => !p.includes('*')));
	const groups = new Map(); // "dev:ino" -> [relative paths]
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(siteRoot, rel))) {
			const entryRel = rel ? `${rel}/${entry}` : entry;
			if (skipDirs.has(entryRel)) {
				continue;
			}
			let stat;
			try {
				stat = fs.lstatSync(path.join(siteRoot, entryRel));
			} catch (err) {
				continue;
			}
			if (stat.isDirectory()) {
				walk(entryRel);
			} else if (stat.isFile() && stat.nlink > 1) {
				const key = `${stat.dev}:${stat.ino}`;
				if (!groups.has(key)) {
					groups.set(key, []);
				}
				groups.get(key).push(entryRel);
			}
		}
	};
	try {
		walk('');
	} catch (err) {
		logger.warn(`Site Beam: hardlink detection failed, exporting as plain copies: ${err.message}`);
		return {};
	}
	const map = {};
	for (const paths of groups.values()) {
		if (paths.length < 2) {
			continue;
		}
		paths.sort();
		for (let i = 1; i < paths.length; i++) {
			map[paths[i]] = paths[0];
		}
	}
	return map;
}

/*
 * Returns { sqlPath, freshDump, cleanup }. Prefers a fresh mysqldump when the
 * site is running; falls back to the last dump Local wrote on site stop.
 */
async function prepareSqlDump(cradle, siteJson) {
	const site = toSite(siteJson);
	const { siteDatabase, siteProcessManager } = cradle;
	let status = 'unknown';
	try {
		status = await Promise.resolve(siteProcessManager.getSiteStatus(site));
	} catch (err) {
		// status stays unknown; fall through to the on-disk dump
	}
	if (status === 'running') {
		const tmpSql = path.join(os.tmpdir(), `site-beam-${site.id}-${Date.now()}.sql`);
		await siteDatabase.dump(site, tmpSql);
		return { sqlPath: tmpSql, freshDump: true, cleanup: () => fs.unlink(tmpSql, () => {}) };
	}
	const savedDump = path.join(LocalMain.formatHomePath(site.paths.sql), 'local.sql');
	if (fs.existsSync(savedDump)) {
		return { sqlPath: savedDump, freshDump: false, cleanup: () => {} };
	}
	const error = new Error(`Site "${site.name}" is not running and has no saved database dump. Start (or start & stop) the site on the source machine first.`);
	error.statusCode = 409;
	throw error;
}

/*
 * Pipes the export zip into `output` (an HTTP response or a file stream).
 * All validation (web root, database dump) happens BEFORE `beforeStream` is
 * called, so an HTTP server can still send a clean error status; after
 * `beforeStream` the zip bytes start flowing. Resolves when fully written.
 */
async function writeExportArchive(cradle, logger, siteJson, output, { beforeStream } = {}) {
	const site = toSite(siteJson);
	const siteRoot = LocalMain.formatHomePath(site.path);
	if (!fs.existsSync(siteRoot)) {
		const error = new Error(`Site folder for "${site.name}" not found at ${siteRoot}.`);
		error.statusCode = 500;
		throw error;
	}
	const webRoot = resolveWebRoot(siteJson);
	const dump = await prepareSqlDump(cradle, siteJson);
	const manifest = buildManifest(siteJson, dump.freshDump);
	manifest.site.sourcePath = siteRoot;
	manifest.site.sourceWebRootName = path.basename(webRoot);
	const hardlinks = detectHardlinks(siteRoot, logger);
	if (Object.keys(hardlinks).length) {
		manifest.hardlinks = hardlinks;
	}
	if (beforeStream) {
		beforeStream(manifest);
	}

	return new Promise((resolve, reject) => {
		// LAN/relay bandwidth beats CPU here, so favour speed over ratio.
		const archive = archiver('zip', { zlib: { level: 1 } });
		let settled = false;
		const finish = (err) => {
			if (settled) {
				return;
			}
			settled = true;
			dump.cleanup();
			if (err) {
				reject(err);
			} else {
				resolve(manifest);
			}
		};
		archive.on('error', (err) => {
			logger.warn(`Site Beam export of "${site.name}" failed: ${err.message}`);
			output.destroy ? output.destroy(err) : null;
			finish(err);
		});
		archive.on('warning', (err) => logger.warn(`Site Beam export warning: ${err.message}`));
		output.on('error', (err) => finish(err));
		output.on(output.writableFinished !== undefined ? 'finish' : 'close', () => finish());

		archive.pipe(output);
		// The whole site folder, real layout preserved.
		// follow: true dereferences symlinks — dev setups often symlink plugins/themes.
		archive.glob('**/*', { cwd: siteRoot, dot: true, follow: false, ignore: EXPORT_IGNORE });
		archive.file(dump.sqlPath, { name: 'app/sql/local.sql' });
		archive.append(JSON.stringify(manifest, null, 2), { name: 'beam-manifest.json' });
		archive.append(JSON.stringify(siteJson, null, 2), { name: 'local-site.json' });
		archive.finalize().catch(finish);
	});
}

async function writeExportZipFile(cradle, logger, siteJson, zipPath) {
	fs.mkdirSync(path.dirname(zipPath), { recursive: true });
	const out = fs.createWriteStream(zipPath);
	return writeExportArchive(cradle, logger, siteJson, out);
}

module.exports = { writeExportArchive, writeExportZipFile, buildManifest, resolveWebRoot, BEAM_FORMAT };
