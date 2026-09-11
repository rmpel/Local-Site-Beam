'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Built-in internet transfers — replaces the external croc binary.
 *
 * Both sides rendezvous on an HTTP "piping server" relay (default: the public
 * https://ppng.io, self-hostable: https://github.com/nwtgck/piping-server).
 * The sender POSTs to a path derived from the code phrase and the receiver
 * GETs the same path; the relay pairs them and streams the bytes through
 * without storing anything. Whichever side arrives first simply waits for the
 * other — that's the whole rendezvous.
 *
 * The payload is end-to-end encrypted: the relay path is a hash of the phrase
 * (so the relay never sees the phrase), and the content is AES-256-GCM in
 * framed chunks under a scrypt key derived from the phrase. Frame indexes are
 * authenticated (AAD), so reordering/truncation is detected, and a final end
 * frame proves the stream is complete. No external binary, nothing to
 * install, and no croc-style "same version on both machines" requirement —
 * the wire format is versioned by the LSB1 magic instead.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_RELAY = 'https://ppng.io';

const MAGIC = Buffer.from('LSB1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const CHUNK_SIZE = 4 * 1024 * 1024;
// Parser sanity cap; anything larger means garbage on the channel.
const MAX_FRAME = 16 * 1024 * 1024;

const FRAME_META = 1;
const FRAME_DATA = 2;
const FRAME_END = 3;

function generatePhrase() {
	const group = () => crypto.randomBytes(3).toString('hex').slice(0, 4);
	return `beam-${group()}-${group()}-${group()}`;
}

function relayBase(relayUrl) {
	const base = String(relayUrl || '').trim() || DEFAULT_RELAY;
	return base.replace(/\/+$/, '');
}

function channelUrl(relayUrl, phrase) {
	// The relay only ever sees this hash, never the phrase itself.
	const channel = crypto.createHash('sha256')
		.update(`local-site-beam:channel:${phrase}`)
		.digest('hex')
		.slice(0, 40);
	return new URL(`${relayBase(relayUrl)}/local-site-beam/${channel}`);
}

function deriveKey(phrase, salt) {
	return crypto.scryptSync(String(phrase), salt, 32);
}

function frameAAD(type, index) {
	const aad = Buffer.alloc(9);
	aad.writeUInt8(type, 0);
	aad.writeBigUInt64BE(BigInt(index), 1);
	return aad;
}

function encryptFrame(key, type, index, payload) {
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(frameAAD(type, index));
	const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
	const head = Buffer.alloc(5);
	head.writeUInt8(type, 0);
	head.writeUInt32BE(ciphertext.length, 1);
	return Buffer.concat([head, iv, ciphertext, cipher.getAuthTag()]);
}

function decryptFrame(key, type, index, iv, ciphertext, tag) {
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAAD(frameAAD(type, index));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function formatMB(bytes) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressLine(verb, bytes, total) {
	if (total) {
		const pct = Math.min(100, Math.floor((bytes / total) * 100));
		return `${verb}… ${pct}% (${formatMB(bytes)} of ${formatMB(total)})`;
	}
	return `${verb}… ${formatMB(bytes)}`;
}

function friendlyNetworkError(err, relayUrl) {
	const relay = relayBase(relayUrl);
	const code = err && err.code;
	if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
		return new Error(`Could not reach the relay at ${relay} (${code}) — check this machine's internet connection, or that the other side didn't disconnect mid-transfer.`);
	}
	return err;
}

function requestModule(url) {
	return url.protocol === 'http:' ? http : https;
}

function writeTo(stream, buffer) {
	return new Promise((resolve, reject) => {
		stream.write(buffer, (err) => (err ? reject(err) : resolve()));
	});
}

/*
 * The relay answers a paired POST with streamed "[INFO] ..." lines (waiting
 * for receiver / receiver connected). Surface them as human status instead of
 * raw relay output.
 */
function infoLineToStatus(line) {
	if (/waiting for/i.test(line)) {
		return 'Waiting for the other machine to start receiving…';
	}
	if (/receiver was connected|start sending/i.test(line)) {
		return 'Receiver connected — sending…';
	}
	return null;
}

function send(zipPath, phrase, onOutput, relayUrl) {
	const url = channelUrl(relayUrl, phrase);
	const totalSize = fs.statSync(zipPath).size;
	const salt = crypto.randomBytes(SALT_LENGTH);
	const key = deriveKey(phrase, salt);

	let req = null;
	let cancelled = false;
	let statusOverridden = false;
	const say = (line) => onOutput && onOutput(line);

	const done = (async () => {
		await new Promise((resolve) => setImmediate(resolve)); // let caller grab `cancel` first
		req = requestModule(url).request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
		});

		let failure = null;
		const response = new Promise((resolve, reject) => {
			req.on('error', (err) => reject(cancelled ? new Error('Transfer cancelled.') : friendlyNetworkError(err, relayUrl)));
			req.on('response', (res) => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					res.on('data', (chunk) => {
						for (const line of chunk.toString('utf8').split(/\r?\n/)) {
							const status = infoLineToStatus(line.trim());
							if (status && !statusOverridden) {
								say(status);
							}
						}
					});
					res.on('end', resolve);
					res.on('error', (err) => reject(friendlyNetworkError(err, relayUrl)));
				} else {
					const chunks = [];
					res.on('data', (c) => chunks.push(c));
					res.on('end', () => {
						const body = Buffer.concat(chunks).toString('utf8').trim();
						reject(new Error(/established already|already/i.test(body)
							? 'This code phrase is already in use on the relay (another send is still waiting, or a stray receiver is connected). Cancel it or generate a new send.'
							: `The relay refused the transfer (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
					});
				}
			});
		});

		// A relay refusal (e.g. phrase already in use) can arrive while a write
		// below is blocked on backpressure; destroying the request unblocks that
		// write with a generic stream error, so remember the real failure here.
		response.catch((err) => {
			failure = failure || err;
			req.destroy(err);
		});

		say('Waiting for the other machine to start receiving…');

		try {
			const meta = { name: path.basename(zipPath), size: totalSize };
			await writeTo(req, Buffer.concat([MAGIC, salt]));
			let index = 0;
			await writeTo(req, encryptFrame(key, FRAME_META, index++, Buffer.from(JSON.stringify(meta), 'utf8')));

			// writeTo resolves when the chunk is flushed to the socket, so the relay's
			// backpressure (it won't read until a receiver is paired) throttles us here.
			const file = fs.createReadStream(zipPath, { highWaterMark: CHUNK_SIZE });
			let sent = 0;
			let lastPct = -1;
			for await (const chunk of file) {
				if (cancelled) {
					throw new Error('Transfer cancelled.');
				}
				await writeTo(req, encryptFrame(key, FRAME_DATA, index++, chunk));
				sent += chunk.length;
				const pct = Math.floor((sent / totalSize) * 100);
				if (pct !== lastPct) {
					lastPct = pct;
					statusOverridden = true;
					say(progressLine('Sending', sent, totalSize));
				}
			}
			await writeTo(req, encryptFrame(key, FRAME_END, index++, Buffer.alloc(0)));
			req.end();
			await response;
		} catch (err) {
			if (cancelled) {
				throw new Error('Transfer cancelled.');
			}
			throw failure || err;
		}
		return `sent ${formatMB(totalSize)}`;
	})();

	const cancel = () => {
		cancelled = true;
		if (req) {
			req.destroy(new Error('Transfer cancelled.'));
		}
	};
	return { cancel, done };
}

/*
 * Incremental frame parser fed by the response stream. Kept as explicit state
 * (header → frames) rather than a Transform so the wrong-phrase case can be
 * told apart from mid-stream corruption: an auth failure on the very first
 * frame means the key (phrase) is wrong.
 */
function createParser(phrase, { onMeta, onData }) {
	let buffer = Buffer.alloc(0);
	let headerDone = false;
	let derivedKey = null;
	let index = 0;
	let ended = false;

	return {
		get ended() {
			return ended;
		},
		async push(chunk) {
			buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
			if (!headerDone) {
				if (buffer.length < MAGIC.length + SALT_LENGTH) {
					return;
				}
				if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
					throw new Error('The sender is not a compatible Site Beam — make sure both machines run Site Beam 1.2.0 or newer.');
				}
				derivedKey = deriveKey(phrase, buffer.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH));
				buffer = buffer.subarray(MAGIC.length + SALT_LENGTH);
				headerDone = true;
			}
			while (buffer.length >= 5) {
				const type = buffer.readUInt8(0);
				const length = buffer.readUInt32BE(1);
				if (![FRAME_META, FRAME_DATA, FRAME_END].includes(type) || length > MAX_FRAME) {
					throw new Error('Received data that is not a Site Beam transfer — is something else using this relay path?');
				}
				const frameEnd = 5 + IV_LENGTH + length + TAG_LENGTH;
				if (buffer.length < frameEnd) {
					return;
				}
				const iv = buffer.subarray(5, 5 + IV_LENGTH);
				const ciphertext = buffer.subarray(5 + IV_LENGTH, 5 + IV_LENGTH + length);
				const tag = buffer.subarray(5 + IV_LENGTH + length, frameEnd);
				let payload;
				try {
					payload = decryptFrame(derivedKey, type, index, iv, ciphertext, tag);
				} catch (err) {
					throw new Error(index === 0
						? 'The code phrase does not match what the sender is using — check it for typos.'
						: 'The transfer was corrupted in transit — try again.');
				}
				buffer = buffer.subarray(frameEnd);
				if (type === FRAME_META) {
					onMeta(JSON.parse(payload.toString('utf8')));
				} else if (type === FRAME_DATA) {
					await onData(payload);
				} else {
					ended = true;
					return;
				}
				index += 1;
			}
		},
	};
}

function receive(phrase, outDir, onOutput, relayUrl) {
	const url = channelUrl(relayUrl, phrase);
	fs.mkdirSync(outDir, { recursive: true });

	let req = null;
	let res = null;
	let cancelled = false;
	const say = (line) => onOutput && onOutput(line);

	const done = (async () => {
		await new Promise((resolve) => setImmediate(resolve)); // let caller grab `cancel` first
		say('Waiting for the sender to connect… if this never progresses, double-check the code phrase and that the sender is still online.');

		res = await new Promise((resolve, reject) => {
			req = requestModule(url).request(url, { method: 'GET' });
			req.on('error', (err) => reject(cancelled ? new Error('Transfer cancelled.') : friendlyNetworkError(err, relayUrl)));
			req.on('response', resolve);
			req.end();
		});
		if (res.statusCode < 200 || res.statusCode >= 300) {
			const chunks = [];
			for await (const c of res) {
				chunks.push(c);
			}
			throw new Error(`The relay refused the transfer (HTTP ${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim().slice(0, 200)}`);
		}

		let out = null;
		let zipPath = null;
		let totalSize = 0;
		let received = 0;
		let lastPct = -1;
		const parser = createParser(phrase, {
			onMeta: (meta) => {
				const safeName = String(meta.name || 'received-beam.zip').replace(/[^A-Za-z0-9._-]/g, '_');
				zipPath = path.join(outDir, safeName.toLowerCase().endsWith('.zip') ? safeName : `${safeName}.zip`);
				totalSize = Number(meta.size) || 0;
				out = fs.createWriteStream(zipPath);
				say(progressLine('Receiving', 0, totalSize));
			},
			onData: async (payload) => {
				if (!out) {
					throw new Error('The transfer was corrupted in transit — try again.');
				}
				await writeTo(out, payload);
				received += payload.length;
				const pct = totalSize ? Math.floor((received / totalSize) * 100) : -1;
				if (pct !== lastPct) {
					lastPct = pct;
					say(progressLine('Receiving', received, totalSize));
				}
			},
		});

		try {
			for await (const chunk of res) {
				if (cancelled) {
					throw new Error('Transfer cancelled.');
				}
				await parser.push(chunk);
				if (parser.ended) {
					break;
				}
			}
			if (!parser.ended) {
				throw new Error(cancelled ? 'Transfer cancelled.' : 'The sender disconnected before the transfer completed — try again.');
			}
			if (!out) {
				throw new Error('The transfer was corrupted in transit — try again.');
			}
		} catch (err) {
			req.destroy();
			if (out) {
				out.destroy();
			}
			throw cancelled ? new Error('Transfer cancelled.') : friendlyNetworkError(err, relayUrl);
		}
		req.destroy(); // frames are complete; drop any relay trailer
		await new Promise((resolve, reject) => {
			out.end((err) => (err ? reject(err) : resolve()));
		});
		return `received ${formatMB(received)}`;
	})();

	const cancel = () => {
		cancelled = true;
		if (req) {
			req.destroy(new Error('Transfer cancelled.'));
		}
	};
	return { cancel, done };
}

module.exports = { send, receive, generatePhrase, relayBase, DEFAULT_RELAY };
