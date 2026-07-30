'use strict';

/**
 * Package: Local Site Beam - Beam your site to another LocalWP installation.
 * Version: see package.json
 * License: see README.md and LICENSE
 * Author: Remon Pel
 * URL: https://github.com/rmpel/Local-Site-Beam/
 */

/*
 * Site Beam UI. Written with React.createElement so no build step is needed.
 * Appears as a "Site Beam" tab under every site's Tools section.
 */

const LocalRenderer = require('@getflywheel/local/renderer');

const border = '1px solid rgba(127,127,127,0.35)';
const muted = { opacity: 0.65, fontSize: 12 };

const styles = {
	page: { padding: 20, height: '100%', overflowY: 'auto', fontSize: 13, lineHeight: 1.5 },
	section: { border, borderRadius: 8, padding: 16, marginBottom: 16 },
	h2: { fontSize: 15, fontWeight: 600, margin: '0 0 8px' },
	input: {
		padding: '6px 10px', border, borderRadius: 6, fontSize: 13,
		background: 'transparent', color: 'inherit', minWidth: 220,
	},
	button: {
		padding: '6px 12px', border, borderRadius: 6, cursor: 'pointer',
		background: 'transparent', color: 'inherit', fontSize: 13,
	},
	primaryButton: {
		padding: '6px 12px', border: '1px solid #2b6cb0', borderRadius: 6, cursor: 'pointer',
		background: '#2b6cb0', color: '#fff', fontSize: 13,
	},
	dangerButton: {
		padding: '6px 12px', border: '1px solid #c53030', borderRadius: 6, cursor: 'pointer',
		background: 'transparent', color: '#c53030', fontSize: 13,
	},
	row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
	table: { width: '100%', borderCollapse: 'collapse', marginTop: 8 },
	cell: { padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.2)', textAlign: 'left', verticalAlign: 'middle' },
	error: { color: '#c53030', marginTop: 8 },
	ok: { color: '#2f855a' },
	badge: { ...{ opacity: 0.65, fontSize: 12 }, border, borderRadius: 10, padding: '1px 8px' },
};

function formatBytes(bytes) {
	if (!bytes) {
		return '0 MB';
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function makeBeamUI(React, electron) {
	const h = React.createElement;
	const ipc = (channel, args) => LocalRenderer.ipcAsync(channel, args);
	const copyText = (text) => {
		try {
			electron.clipboard.writeText(text);
		} catch (err) {
			// clipboard unavailable — the phrase is still selectable text
		}
	};

	function TransferBanner({ transfer, onClear }) {
		if (!transfer) {
			return null;
		}
		const color = transfer.error ? '#c53030' : (transfer.done ? '#2f855a' : '#2b6cb0');
		return h('div', { style: { ...styles.section, borderColor: color } },
			h('div', { style: styles.row },
				h('strong', null, transfer.error ? 'Transfer failed' : (transfer.done ? 'Transfer complete' : `Transferring "${transfer.siteName || ''}"…`)),
				transfer.bytesReceived ? h('span', { style: muted }, formatBytes(transfer.bytesReceived)) : null,
				(transfer.done || transfer.error) ? h('button', { style: styles.button, onClick: onClear }, 'Dismiss') : null,
			),
			h('div', { style: { marginTop: 4, color: transfer.error ? '#c53030' : 'inherit' } }, transfer.message || transfer.phase),
		);
	}

	function PeerSites({ peer, data, busy, onPull }) {
		const [armedOverwrite, setArmedOverwrite] = React.useState(null);
		if (!data) {
			return null;
		}
		if (data.error) {
			return h('div', { style: styles.error }, data.error);
		}
		if (data.loading) {
			return h('div', { style: muted }, 'Loading site list…');
		}
		if (!data.sites || !data.sites.length) {
			return h('div', { style: muted }, 'No sites on this machine.');
		}
		return h('table', { style: styles.table },
			h('thead', null, h('tr', null,
				['Site', 'Domain', 'PHP', 'Status', ''].map((label, i) => h('th', { key: i, style: { ...styles.cell, ...muted } }, label)),
			)),
			h('tbody', null, data.sites.map((site) => {
				const armed = armedOverwrite === site.id;
				let actions;
				if (busy) {
					actions = h('span', { style: muted }, '…');
				} else if (!site.existsLocally) {
					actions = h('button', {
						style: styles.primaryButton,
						onClick: () => onPull(peer, site, 'new'),
					}, 'Copy to this computer');
				} else {
					actions = h('span', { style: styles.row },
						h('span', { style: styles.badge }, 'already here'),
						h('button', {
							style: styles.button,
							title: 'Import as a new, renamed site next to the existing one',
							onClick: () => onPull(peer, site, 'rename'),
						}, 'Copy as new'),
						h('button', {
							style: styles.dangerButton,
							title: armed ? 'This replaces the local files and database. No undo.' : 'Replace the local copy with this one',
							onClick: () => {
								if (armed) {
									setArmedOverwrite(null);
									onPull(peer, site, 'overwrite');
								} else {
									setArmedOverwrite(site.id);
								}
							},
						}, armed ? 'Really overwrite? (no undo)' : 'Overwrite'),
					);
				}
				return h('tr', { key: site.id },
					h('td', { style: styles.cell }, site.name),
					h('td', { style: styles.cell }, site.domain || '—'),
					h('td', { style: styles.cell }, site.php || '—'),
					h('td', { style: styles.cell }, site.status || '—'),
					h('td', { style: { ...styles.cell, textAlign: 'right' } }, actions),
				);
			})),
		);
	}

	function CrocJob({ label, job, onCancel, onClear, showPhrase, copyText }) {
		const [copied, setCopied] = React.useState(false);
		if (!job) {
			return null;
		}
		const color = job.error ? '#c53030' : (job.done ? '#2f855a' : 'inherit');
		const active = !job.done && !job.error;
		return h('div', { style: { marginTop: 8 } },
			h('div', { style: styles.row },
				h('strong', null, label),
				active ? h('button', { style: styles.button, onClick: onCancel }, 'Cancel') : null,
				!active ? h('button', { style: styles.button, onClick: onClear }, 'Dismiss') : null,
			),
			showPhrase && job.phrase ? h('div', { style: { ...styles.row, marginTop: 6 } },
				h('span', { style: muted }, 'Code phrase for the other machine:'),
				h('code', {
					style: { border, borderRadius: 6, padding: '4px 10px', fontSize: 15, userSelect: 'all', opacity: active ? 1 : 0.6 },
				}, job.phrase),
				copyText ? h('button', {
					style: styles.button,
					onClick: () => {
						copyText(job.phrase);
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					},
				}, copied ? 'Copied ✓' : 'Copy') : null,
			) : null,
			h('div', { style: { color, marginTop: 2, ...(active ? muted : {}) } }, job.message || ''),
		);
	}

	return function BeamUI() {
		const [state, setState] = React.useState(null);
		const [codeInput, setCodeInput] = React.useState(null);
		const [manualInput, setManualInput] = React.useState('');
		const [peerSites, setPeerSites] = React.useState({});
		const [crocSiteId, setCrocSiteId] = React.useState('');
		const [crocPhrase, setCrocPhrase] = React.useState('');
		const [crocMode, setCrocMode] = React.useState('new');
		const [uiError, setUiError] = React.useState(null);
		const pageRef = React.useRef(null);

		// Errors and the transfer banner render at the top of the page; make
		// sure they're actually seen when the user is scrolled down.
		const scrollToTop = () => {
			if (pageRef.current) {
				pageRef.current.scrollTop = 0;
			}
		};

		const refresh = React.useCallback(async () => {
			try {
				setState(await ipc('site-beam:get-state'));
			} catch (err) {
				// main process not ready yet; retry on next tick
			}
		}, []);

		React.useEffect(() => {
			refresh();
			const timer = setInterval(refresh, 2500);
			return () => clearInterval(timer);
		}, [refresh]);

		const run = async (channel, args) => {
			setUiError(null);
			try {
				const result = await ipc(channel, args);
				await refresh();
				return result;
			} catch (err) {
				setUiError(err && err.message ? err.message.replace(/^.*Error:\s*/, '') : String(err));
				await refresh();
				scrollToTop();
				return null;
			}
		};

		const loadPeerSites = async (peer) => {
			const key = `${peer.host}:${peer.port}`;
			setPeerSites((prev) => ({ ...prev, [key]: { loading: true } }));
			try {
				const result = await ipc('site-beam:peer-sites', { host: peer.host, port: peer.port });
				setPeerSites((prev) => ({ ...prev, [key]: { sites: result.sites } }));
			} catch (err) {
				setPeerSites((prev) => ({ ...prev, [key]: { error: err && err.message ? err.message.replace(/^.*Error:\s*/, '') : String(err) } }));
			}
		};

		const pull = (peer, site, mode) => {
			scrollToTop();
			return run('site-beam:pull', {
				peer: { host: peer.host, port: peer.port, name: peer.name },
				siteId: site.id,
				siteName: site.name,
				mode,
			}).then(() => loadPeerSites(peer));
		};

		if (!state) {
			return h('div', { style: styles.page }, 'Connecting to Site Beam…');
		}

		const transferBusy = !!(state.transfer && !state.transfer.done && !state.transfer.error);
		const croc = state.croc || {};
		const codeValue = codeInput === null ? '' : codeInput;

		return h('div', { style: styles.page, ref: pageRef },
			h('h1', { style: { fontSize: 18, margin: '0 0 4px' } }, 'Site Beam'),
			h('div', { style: { ...muted, marginBottom: 16 } },
				'Copy complete sites between computers running Local. Same shared code + same network = they find each other.'),

			uiError ? h('div', { style: { ...styles.section, borderColor: '#c53030', color: '#c53030' } }, uiError) : null,
			h(TransferBanner, { transfer: state.transfer, onClear: () => run('site-beam:clear-transfer') }),

			// Shared code + status
			h('div', { style: styles.section },
				h('h2', { style: styles.h2 }, 'Shared code'),
				h('div', { style: styles.row },
					h('input', {
						style: styles.input,
						type: 'text',
						placeholder: state.codeSet ? '(code is set — type to replace)' : 'e.g. purple-elephant-42',
						value: codeValue,
						onChange: (e) => setCodeInput(e.target.value),
					}),
					h('button', {
						style: styles.primaryButton,
						disabled: codeInput === null,
						onClick: () => run('site-beam:set-code', { code: codeValue }).then(() => setCodeInput(null)),
					}, 'Save & connect'),
				),
				h('div', { style: { marginTop: 8 } },
					state.networkError
						? h('span', { style: styles.error }, `Network error: ${state.networkError}`)
						: state.listening
							? h('span', null,
								h('span', { style: styles.ok }, '● '),
								`Discoverable as "${state.displayName}" — this machine: `,
								h('code', null, (state.listening.addresses[0] || 'localhost') + ':' + state.listening.port))
							: h('span', { style: muted }, 'Set the same code on every computer to connect them.'),
				),
			),

			// Peers
			h('div', { style: styles.section },
				h('h2', { style: styles.h2 }, `Computers on your network (${(state.peers || []).length})`),
				(state.peers || []).length === 0
					? h('div', { style: muted }, state.codeSet
						? 'Searching… make sure the other computer runs Local with Site Beam and the same code. If your network blocks discovery, add it by address below.'
						: 'Set a shared code first.')
					: null,
				(state.peers || []).map((peer) => {
					const key = `${peer.host}:${peer.port}`;
					return h('div', { key, style: { marginTop: 10 } },
						h('div', { style: styles.row },
							h('strong', null, peer.name),
							h('span', { style: muted }, `${peer.host}:${peer.port}`),
							h('span', { style: styles.badge }, peer.via === 'manual' ? 'manual' : 'auto-discovered'),
							h('button', { style: styles.button, onClick: () => loadPeerSites(peer) },
								peerSites[key] ? 'Refresh sites' : 'Browse sites'),
							peer.via === 'manual'
								? h('button', { style: styles.button, onClick: () => run('site-beam:remove-manual-peer', { address: peer.name }) }, 'Remove')
								: null,
						),
						h(PeerSites, { peer, data: peerSites[key], busy: transferBusy, onPull: pull }),
					);
				}),
				h('div', { style: { ...styles.row, marginTop: 12 } },
					h('input', {
						style: styles.input,
						placeholder: 'Add by address, e.g. 192.168.1.20:47600',
						value: manualInput,
						onChange: (e) => setManualInput(e.target.value),
					}),
					h('button', {
						style: styles.button,
						onClick: () => run('site-beam:add-manual-peer', { address: manualInput }).then(() => setManualInput('')),
					}, 'Add'),
				),
			),

			// croc / internet transfers
			h('div', { style: styles.section },
				h('h2', { style: styles.h2 }, 'Internet transfer (croc)'),
				croc.available
					? h('div', null,
						h('div', { style: { ...muted, marginBottom: 8 } },
							`For computers that are not on the same network. End-to-end encrypted via a one-time code phrase (uses the public croc relay). Using croc v${croc.version || '?'} — `,
							h('strong', null, 'both machines must run the same croc version'),
							' (mismatched versions fail with "could not secure channel").'),
						h('div', { style: styles.row },
							h('select', {
								style: styles.input,
								value: crocSiteId,
								onChange: (e) => setCrocSiteId(e.target.value),
							},
								h('option', { value: '' }, 'Choose a site to send…'),
								(state.localSites || []).map((s) => h('option', { key: s.id, value: s.id }, s.name)),
							),
							h('button', {
								style: styles.primaryButton,
								disabled: !crocSiteId || (croc.sending && !croc.sending.done && !croc.sending.error),
								onClick: () => run('site-beam:croc-send', { siteId: crocSiteId }),
							}, 'Send'),
						),
						h(CrocJob, {
							label: croc.sending ? `Sending "${croc.sending.siteName}"` : '',
							job: croc.sending,
							showPhrase: true,
							copyText,
							onCancel: () => run('site-beam:croc-cancel', { which: 'send' }),
							onClear: () => run('site-beam:croc-clear', { which: 'send' }),
						}),
						h('div', { style: { ...styles.row, marginTop: 12 } },
							h('input', {
								style: styles.input,
								placeholder: 'Code phrase from the other machine',
								value: crocPhrase,
								onChange: (e) => setCrocPhrase(e.target.value),
							}),
							h('select', {
								style: styles.input,
								value: crocMode,
								onChange: (e) => setCrocMode(e.target.value),
								title: 'What to do if the site already exists here',
							},
								h('option', { value: 'new' }, 'If it exists here: skip'),
								h('option', { value: 'rename' }, 'If it exists here: rename'),
								h('option', { value: 'overwrite' }, 'If it exists here: overwrite'),
							),
							h('button', {
								style: styles.button,
								disabled: !crocPhrase || transferBusy || (croc.receiving && !croc.receiving.done && !croc.receiving.error),
								onClick: () => run('site-beam:croc-receive', { phrase: crocPhrase, mode: crocMode }).then(() => setCrocPhrase('')),
							}, 'Receive'),
						),
						h(CrocJob, {
							label: 'Receiving',
							job: croc.receiving,
							onCancel: () => run('site-beam:croc-cancel', { which: 'receive' }),
							onClear: () => run('site-beam:croc-clear', { which: 'receive' }),
						}),
					)
					: h('div', null,
						h('div', { style: muted }, 'croc is not installed. It enables transfers between computers on different networks.'),
						h('div', { style: { ...styles.row, marginTop: 8 } },
							croc.brewAvailable
								? h('button', {
									style: styles.button,
									disabled: !!croc.installing,
									onClick: () => run('site-beam:croc-install'),
								}, croc.installing ? 'Installing…' : 'Install croc with Homebrew')
								: h('span', { style: muted }, 'Install it from https://github.com/schollz/croc, then revisit this tab.'),
						),
						croc.installing ? h('div', { style: { ...muted, marginTop: 4 } }, croc.installing.message) : null,
					),
			),

			h('div', { style: muted },
				'Transfers include the complete site folder and the full database. The shared code never leaves this machine; ',
				'peers authenticate with a signature derived from it. First transfer on macOS may trigger a firewall prompt — allow Local to accept incoming connections. ',
				'After importing, Local may need the web server (Apache/nginx) and PHP version re-selected once on the new site — available versions differ between machines.'),
		);
	};
}

function renderer(context) {
	const { React, hooks, electron } = context;
	const h = React.createElement;
	const BeamUI = makeBeamUI(React, electron);

	hooks.addFilter('siteInfoToolsItem', (menu) => {
		menu.push({
			path: '/site-beam',
			menuItem: 'Site Beam',
			render: () => h(BeamUI, {}),
		});
		return menu;
	});
}

module.exports = renderer;
module.exports.default = renderer;
