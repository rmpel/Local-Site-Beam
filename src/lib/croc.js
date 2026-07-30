'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Optional cross-internet transfers via croc (https://github.com/schollz/croc).
 *
 * croc relays end-to-end encrypted transfers through a public relay using a
 * PAKE code phrase, so two machines that are NOT on the same network can still
 * exchange a site — zero config. We shell out to the binary if it's installed
 * (Homebrew paths are checked explicitly, since GUI apps don't inherit the
 * shell PATH) and offer a one-click `brew install croc` when it isn't.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTRA_PATHS = [
	'/opt/homebrew/bin',
	'/usr/local/bin',
	'/home/linuxbrew/.linuxbrew/bin',
];

function candidateNames(name) {
	return process.platform === 'win32' ? [`${name}.exe`, name] : [name];
}

function findBinary(name) {
	const dirs = [...EXTRA_PATHS, ...String(process.env.PATH || '').split(path.delimiter)];
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		for (const file of candidateNames(name)) {
			const candidate = path.join(dir, file);
			try {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			} catch (err) { /* unreadable dir */ }
		}
	}
	return null;
}

function spawnEnv() {
	const env = { ...process.env };
	env.PATH = [env.PATH || '', ...EXTRA_PATHS].filter(Boolean).join(path.delimiter);
	return env;
}

function generatePhrase() {
	const group = () => crypto.randomBytes(3).toString('hex').slice(0, 4);
	return `beam-${group()}-${group()}-${group()}`;
}

function runProcess(binary, args, { onOutput, cwd, extraEnv } = {}) {
	// stdin MUST be ignored: croc treats a piped stdin as "data is being piped
	// in" and buffers it to ./croc-stdin-* in its cwd — which is / (read-only)
	// when spawned from Local's main process. cwd is set to a writable dir for
	// the same reason.
	const child = spawn(binary, args, {
		env: { ...spawnEnv(), ...(extraEnv || {}) },
		cwd: cwd || os.tmpdir(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const tail = [];
	const capture = (chunk) => {
		const text = chunk.toString('utf8');
		for (const line of text.split(/\r?\n|\r/)) {
			const trimmed = line.trim();
			if (trimmed) {
				tail.push(trimmed);
				if (tail.length > 12) {
					tail.shift();
				}
				if (onOutput) {
					onOutput(trimmed);
				}
			}
		}
	};
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	const done = new Promise((resolve, reject) => {
		child.on('error', (err) => reject(new Error(`Could not run ${path.basename(binary)}: ${err.message}`)));
		child.on('exit', (code, signal) => {
			if (code === 0) {
				resolve(tail.slice(-6).join(' | '));
			} else if (signal || child.killed) {
				reject(new Error('Transfer cancelled.'));
			} else {
				reject(new Error(`${path.basename(binary)} exited with code ${code}: ${tail.slice(-3).join(' | ')}`));
			}
		});
	});
	return { child, done };
}

let cachedVersion = { path: null, version: null };

function getVersion(crocPath) {
	if (!crocPath) {
		return null;
	}
	if (cachedVersion.path === crocPath) {
		return cachedVersion.version;
	}
	try {
		const out = require('child_process')
			.execFileSync(crocPath, ['--version'], { env: spawnEnv(), timeout: 5000 })
			.toString();
		const match = out.match(/v?(\d+\.\d+\.\d+)/);
		cachedVersion = { path: crocPath, version: match ? match[1] : out.trim() };
	} catch (err) {
		cachedVersion = { path: crocPath, version: null };
	}
	return cachedVersion.version;
}

function status() {
	const crocPath = findBinary('croc');
	return {
		crocPath,
		brewPath: findBinary('brew'),
		version: getVersion(crocPath),
	};
}

/*
 * The code phrase is passed via CROC_SECRET: modern croc (>= 9.6.5) REFUSES
 * --code on the command line (secret visible in ps) and exits 0 with just a
 * usage hint — which looks like a successful instant send. --no-local forces
 * the public relay: croc's local-relay optimization opens direct TCP ports
 * that firewalls silently block, stranding the receiver at "securing channel".
 */
function send(zipPath, phrase, onOutput) {
	const crocPath = findBinary('croc');
	if (!crocPath) {
		throw new Error('croc is not installed.');
	}
	return runProcess(crocPath, ['send', '--no-local', zipPath], {
		onOutput,
		cwd: path.dirname(zipPath),
		extraEnv: { CROC_SECRET: phrase },
	});
}

function receive(phrase, outDir, onOutput) {
	const crocPath = findBinary('croc');
	if (!crocPath) {
		throw new Error('croc is not installed.');
	}
	fs.mkdirSync(outDir, { recursive: true });
	return runProcess(crocPath, ['--yes', '--out', outDir], {
		onOutput,
		cwd: outDir,
		extraEnv: { CROC_SECRET: phrase },
	});
}

function installWithBrew(onOutput) {
	const brewPath = findBinary('brew');
	if (!brewPath) {
		throw new Error('Homebrew not found — install croc manually: https://github.com/schollz/croc');
	}
	return runProcess(brewPath, ['install', 'croc'], { onOutput });
}

module.exports = { status, send, receive, installWithBrew, generatePhrase };
