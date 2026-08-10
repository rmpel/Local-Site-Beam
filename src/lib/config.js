'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

const os = require('os');
const crypto = require('crypto');

const LocalMain = require('@getflywheel/local/main');

const STORE_NAME = 'site-beam';

function newInstanceId() {
	return crypto.randomBytes(8).toString('hex');
}

function autoDisplayName() {
	return os.hostname().replace(/\.local$/i, '');
}

function loadConfig() {
	let data = {};
	try {
		data = LocalMain.UserData.get(STORE_NAME, {}) || {};
	} catch (err) {
		data = {};
	}
	let changed = false;
	if (!data.instanceId) {
		data.instanceId = newInstanceId();
		changed = true;
	}
	// The display name tracks the machine's hostname, so renaming the computer
	// renames it here too (a duplicated VM used to keep the original's name).
	if (data.displayName !== autoDisplayName()) {
		data.displayName = autoDisplayName();
		changed = true;
	}
	if (typeof data.sharedCode !== 'string') {
		data.sharedCode = '';
		changed = true;
	}
	if (!Array.isArray(data.manualPeers)) {
		data.manualPeers = [];
		changed = true;
	}
	if (changed) {
		saveConfig(data);
	}
	return data;
}

function saveConfig(data) {
	try {
		LocalMain.UserData.set(STORE_NAME, data);
	} catch (err) {
		// UserData writes into Local's user-data dir; if that fails there is
		// nothing sensible to fall back to — the add-on keeps working in-memory.
	}
}

function resetConfig() {
	saveConfig({});
	return loadConfig();
}

module.exports = { loadConfig, saveConfig, resetConfig, newInstanceId };
