'use strict';

const fs = require('fs');
const http = require('http');

const { signedHeaders } = require('./auth');

const JSON_TIMEOUT_MS = 15000;

function rawRequest(peer, key, pathname, { timeout } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: peer.host,
			port: peer.port,
			path: pathname,
			method: 'GET',
			headers: signedHeaders(key, 'GET', pathname),
		}, resolve);
		req.on('error', reject);
		if (timeout) {
			req.setTimeout(timeout, () => req.destroy(new Error(`Connection to ${peer.host}:${peer.port} timed out`)));
		}
		req.end();
	});
}

function readBody(res) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		res.on('data', (chunk) => chunks.push(chunk));
		res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		res.on('error', reject);
	});
}

async function failureFromResponse(res, peer) {
	const body = await readBody(res).catch(() => '');
	let message = `Peer ${peer.host}:${peer.port} responded with HTTP ${res.statusCode}`;
	try {
		const parsed = JSON.parse(body);
		if (parsed && parsed.error) {
			message = parsed.error;
		}
	} catch (err) {
		// non-JSON error body, keep generic message
	}
	if (res.statusCode === 401) {
		message = `Peer ${peer.host}:${peer.port} rejected the request — its shared code differs from yours.`;
	}
	const error = new Error(message);
	error.statusCode = res.statusCode;
	return error;
}

async function getJSON(peer, key, pathname) {
	const res = await rawRequest(peer, key, pathname, { timeout: JSON_TIMEOUT_MS });
	if (res.statusCode !== 200) {
		throw await failureFromResponse(res, peer);
	}
	const body = await readBody(res);
	return JSON.parse(body);
}

async function downloadToFile(peer, key, pathname, destination, onBytes) {
	const res = await rawRequest(peer, key, pathname);
	if (res.statusCode !== 200) {
		throw await failureFromResponse(res, peer);
	}
	return new Promise((resolve, reject) => {
		const out = fs.createWriteStream(destination);
		let bytes = 0;
		res.on('data', (chunk) => {
			bytes += chunk.length;
			if (onBytes) {
				onBytes(bytes);
			}
		});
		res.on('error', (err) => {
			out.destroy();
			reject(err);
		});
		out.on('error', reject);
		out.on('finish', () => resolve(bytes));
		res.pipe(out);
	});
}

module.exports = { getJSON, downloadToFile };
