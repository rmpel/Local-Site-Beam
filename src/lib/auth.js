'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Shared-code based authentication.
 *
 * The shared code itself never travels over the network:
 *  - discovery advertises only a truncated fingerprint hash, so peers can
 *    recognise each other without exposing the code;
 *  - every HTTP request is signed with an HMAC over timestamp + method + path.
 */

const crypto = require('crypto');

const KEY_CONTEXT = 'local-site-beam|key|v1|';
const FP_CONTEXT = 'local-site-beam|fp|v1|';
const MAX_SKEW_SECONDS = 300;

function deriveKey(sharedCode) {
	return crypto.createHash('sha256').update(KEY_CONTEXT + sharedCode).digest();
}

function fingerprint(sharedCode) {
	return crypto.createHash('sha256').update(FP_CONTEXT + sharedCode).digest('hex').slice(0, 16);
}

function sign(key, method, pathname, ts) {
	return crypto.createHmac('sha256', key).update(`${ts}\n${method}\n${pathname}`).digest('hex');
}

function signedHeaders(key, method, pathname) {
	const ts = String(Math.floor(Date.now() / 1000));
	return {
		'x-beam-ts': ts,
		'x-beam-sig': sign(key, method, pathname, ts),
	};
}

function verifyRequest(key, method, pathname, ts, sig) {
	if (!key || !ts || !sig) {
		return false;
	}
	if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) {
		return false;
	}
	const expected = sign(key, method, pathname, ts);
	let given;
	try {
		given = Buffer.from(String(sig), 'hex');
	} catch (err) {
		return false;
	}
	const wanted = Buffer.from(expected, 'hex');
	return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

module.exports = { deriveKey, fingerprint, sign, signedHeaders, verifyRequest };
