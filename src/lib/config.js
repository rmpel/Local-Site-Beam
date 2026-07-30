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

function loadConfig() {
	let data = {};
	try {
		data = LocalMain.UserData.get(STORE_NAME, {}) || {};
	} catch (err) {
		data = {};
	}
	let changed = false;
	if (!data.instanceId) {
		data.instanceId = crypto.randomBytes(8).toString('hex');
		changed = true;
	}
	if (!data.displayName) {
		data.displayName = os.hostname().replace(/\.local$/i, '');
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

module.exports = { loadConfig, saveConfig };
