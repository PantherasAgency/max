import express from 'express';

// Node 18+ has global fetch. If you’re on older Node, uncomment:
// import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;

if (!AIRTABLE_TOKEN) console.error('Missing AIRTABLE_TOKEN');
if (!WAVESPEED_API_KEY) console.error('Missing WAVESPEED_API_KEY');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAirtableRecord(baseId, tableIdOrName, recordId) {
	const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(
		tableIdOrName
	)}/${encodeURIComponent(recordId)}`;
	const resp = await fetch(url, {
		headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
	});
	if (!resp.ok) throw new Error(`Airtable GET failed ${resp.status} ${await resp.text()}`);
	return resp.json();
}

async function patchAirtableRecord(baseId, tableIdOrName, recordId, fields) {
	const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}`;
	const body = { records: [{ id: recordId, fields }] };
	const resp = await fetch(url, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${AIRTABLE_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	if (!resp.ok) throw new Error(`Airtable PATCH failed ${resp.status} ${await resp.text()}`);
	return resp.json();
}

function resolutionToSize(resolutionField) {
	if (!resolutionField || typeof resolutionField !== 'string') return '2160*3840';
	const parts = resolutionField
		.toLowerCase()
		.split('x')
		.map((s) => s.trim());
	if (parts.length !== 2) return '2160*3840';
	return `${parts[0]}*${parts[1]}`;
}

async function submitEditTask({ images, prompt, size }) {
	const resp = await fetch('https://api.wavespeed.ai/api/v3/bytedance/seedream-v4/edit', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WAVESPEED_API_KEY}` },
		body: JSON.stringify({
			enable_base64_output: false,
			enable_sync_mode: false,
			images,
			prompt,
			size,
		}),
	});
	if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
	const data = await resp.json();
	const id = data?.data?.id;
	if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
	return id;
}

async function pollResult(requestId, timeoutMs) {
	const start = Date.now();
	let lastStatus = 'unknown';
	while (Date.now() - start < timeoutMs) {
		const resp = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`, {
			headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
		});
		const json = await resp.json();
		if (!resp.ok) throw new Error(`Wavespeed poll failed ${resp.status} ${JSON.stringify(json)}`);
		const status = json?.data?.status;
		if (status !== lastStatus) {
			console.log(`[seedance-edit] ${requestId} -> ${status}`);
			lastStatus = status;
		}
		if (status === 'completed') return json?.data?.outputs || [];
		if (status === 'failed') throw new Error(`Wavespeed task failed: ${json?.data?.error || 'unknown'}`);
		await sleep(1500);
	}
	throw new Error('Wavespeed poll timed out');
}

function chunk(arr, size) {
	const out = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

app.get('/', (_, res) => res.type('text/plain').send('running'));

/* === SEEDREAM EDIT === */
app.get('/v1/automations/webhookSeedanceEditGen', async (req, res) => {
	const baseId = req.query.baseId;
	const recordId = req.query.recordId;
	const tableIdOrName = req.query.tableIdOrName || 'IMG GEN';
	const fieldName = req.query.fieldName || 'Attachments';
	const statusField = 'Status';
	const errField = 'err_msg';

	if (!baseId || !recordId) return res.status(400).json({ ok: false, error: 'baseId and recordId are required' });
	if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY)
		return res.status(500).json({ ok: false, error: 'Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY' });

	console.log('[seedance-edit] received:', { baseId, recordId, tableIdOrName, fieldName });

	try {
		await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: 'Generating', [errField]: '' });

		const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
		const fields = record?.fields || {};

		const faceRef = fields['face_reference'];
		const prompt = fields['prompt'] || '';
		const resolution = fields['resolution'] || fields['Resolution'] || '2160x3840';
		const size = resolutionToSize(resolution);

		const desired = Math.max(1, Math.min(8, parseInt(req.query.n || fields['amount_outputs'] || '4', 10)));
		const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || '900', 10)));
		const perTaskTimeoutMs = timeoutSec * 1000;
		const MAX_CONCURRENCY = 4;

		const inputUrls = Array.isArray(faceRef)
			? faceRef
					.filter((x) => x?.url)
					.map((x) => x.url)
					.slice(0, 10)
			: [];
		if (!inputUrls.length) throw new Error("No input images in 'face_reference'");

		const submitPromises = Array.from({ length: desired }, () => submitEditTask({ images: inputUrls, prompt, size }));
		const taskIds = await Promise.all(submitPromises);
		console.log(`[seedance-edit] submitting ${desired} tasks ->`, taskIds);

		const idBatches = chunk(taskIds, MAX_CONCURRENCY);
		const successes = [];
		const failures = [];

		for (const batch of idBatches) {
			const results = await Promise.allSettled(batch.map((id) => pollResult(id, perTaskTimeoutMs)));
			results.forEach((r, idx) => {
				const id = batch[idx];
				if (r.status === 'fulfilled') successes.push(...r.value);
				else failures.push({ id, error: r.reason?.message || String(r.reason) });
			});
		}

		if (!successes.length && failures.length) {
			throw new Error(
				`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`
			);
		}

		const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map((x) => ({ url: x.url })) : [];
		const finalAttachments = [...existing, ...successes.map((url) => ({ url }))];

		const hadFailures = failures.length > 0;
		await patchAirtableRecord(baseId, tableIdOrName, recordId, {
			[fieldName]: finalAttachments,
			[statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : 'Success',
			[errField]: hadFailures
				? failures
						.map((f) => `${f.id}: ${f.error}`)
						.join(' | ')
						.slice(0, 1000)
				: '',
		});

		console.log(`[seedance-edit] outputs: ${successes.length}/${desired} for record ${recordId}`);
		res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
	} catch (err) {
		console.error('[seedance-edit] ERROR:', err?.message || err);
		try {
			await patchAirtableRecord(baseId, tableIdOrName, recordId, {
				[errField]: String(err?.message || err),
				[statusField]: 'Error',
			});
		} catch {}
		res.status(500).json({ ok: false, error: String(err?.message || err) });
	}
});

/* === KLING 2.1 === */
async function submitKling21Task({ image, prompt, negative_prompt, duration, guidance_scale }) {
	const resp = await fetch('https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.1-i2v-standard', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WAVESPEED_API_KEY}` },
		body: JSON.stringify({ image, prompt, negative_prompt, duration, guidance_scale }),
	});
	if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
	const data = await resp.json();
	const id = data?.data?.id;
	if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
	return id;
}

app.get('/v1/automations/webhookKling21Std', async (req, res) => {
	const baseId = req.query.baseId;
	const recordId = req.query.recordId;
	const tableIdOrName = req.query.tableIdOrName || 'tblaauQEiqREQUhHq';
	const fieldName = req.query.fieldName || 'generated_outputs';
	const statusField = 'Status';
	const errField = 'err_msg';

	try {
		await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: 'Generating', [errField]: '' });

		const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
		const fields = record?.fields || {};

		const srcArr = Array.isArray(fields['fldpcNNeTNguuAWno'])
			? fields['fldpcNNeTNguuAWno']
			: Array.isArray(fields['sourceImg'])
			? fields['sourceImg']
			: [];
		const imageUrl = srcArr[0]?.url;
		if (!imageUrl) throw new Error("No image found in 'sourceImg' field");

		const prompt = (fields['chatgpt_prompt'] || '').toString().trim();
		if (!prompt) throw new Error('Missing chatgpt_prompt field');

		const duration = parseInt(fields['duration'] || '5', 10);
		const guidance_scale = 0.5;
		const negative_prompt = 'blur, distort, and low quality';

		function readDesired(nField) {
			if (typeof nField === 'number') return nField;
			if (typeof nField === 'string') return parseInt(nField, 10);
			if (nField && typeof nField === 'object' && typeof nField.name === 'string') return parseInt(nField.name, 10);
			return NaN;
		}
		const desiredRaw = req.query.n ?? fields['amount_outputs'] ?? fields['Amount outputs'] ?? '1';
		let desired = readDesired(desiredRaw);
		if (!Number.isFinite(desired) || desired < 1) desired = 1;
		if (desired > 8) desired = 8;

		const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || '900', 10)));
		const perTaskTimeoutMs = timeoutSec * 1000;
		const MAX_CONCURRENCY = 4;

		const submitPromises = Array.from({ length: desired }, () =>
			submitKling21Task({ image: imageUrl, prompt, negative_prompt, duration, guidance_scale })
		);
		const taskIds = await Promise.all(submitPromises);
		console.log(`[kling21] submitting ${desired} tasks ->`, taskIds);

		const idBatches = chunk(taskIds, MAX_CONCURRENCY);
		const successes = [];
		const failures = [];

		for (const batch of idBatches) {
			const results = await Promise.allSettled(batch.map((id) => pollResult(id, perTaskTimeoutMs)));
			results.forEach((r, idx) => {
				const id = batch[idx];
				if (r.status === 'fulfilled') successes.push(...r.value);
				else failures.push({ id, error: r.reason?.message || String(r.reason) });
			});
		}

		if (!successes.length && failures.length) {
			throw new Error(
				`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`
			);
		}

		const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map((x) => ({ url: x.url })) : [];
		const newFiles = successes.map((url, i) => ({ url, filename: `kling_${Date.now()}_${i}.mp4` }));
		const finalAttachments = [...existing, ...newFiles];

		const hadFailures = failures.length > 0;
		await patchAirtableRecord(baseId, tableIdOrName, recordId, {
			[fieldName]: finalAttachments,
			[statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : 'Success',
			[errField]: hadFailures
				? failures
						.map((f) => `${f.id}: ${f.error}`)
						.join(' | ')
						.slice(0, 1000)
				: '',
		});

		res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
	} catch (err) {
		console.error('[kling21] ERROR:', err.message);
		try {
			await patchAirtableRecord(baseId, tableIdOrName, recordId, { [errField]: err.message, [statusField]: 'Error' });
		} catch {}
		res.status(500).json({ ok: false, error: err.message });
	}
});

/* === KLING 2.5 TURBO === */
async function submitKling25TurboTask({ image, prompt, negative_prompt, duration, guidance_scale }) {
	const resp = await fetch('https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.5-turbo-std/image-to-video', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${WAVESPEED_API_KEY}`,
		},
		body: JSON.stringify({ image, prompt, negative_prompt, duration, guidance_scale }),
	});
	if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
	const data = await resp.json();
	const id = data?.data?.id;
	if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
	return id;
}

app.get('/v1/automations/webhookKling25Turbo', async (req, res) => {
	const baseId = req.query.baseId;
	const recordId = req.query.recordId;
	const tableIdOrName = req.query.tableIdOrName || 'tbliEm1efdgbRIFMb';
	const fieldName = req.query.fieldName || 'generated_outputs';
	const statusField = 'Status';
	const errField = 'err_msg';

	try {
		if (!baseId || !recordId) return res.status(400).json({ ok: false, error: 'baseId and recordId are required' });
		if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY)
			return res.status(500).json({ ok: false, error: 'Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY' });

		await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: 'Generating', [errField]: '' });

		const record = await getAirtableRecord(baseId, tableIdOrName, recordId);
		const fields = record?.fields || {};

		const srcArr = Array.isArray(fields['fldxGFYOQAF1voks9'])
			? fields['fldxGFYOQAF1voks9']
			: Array.isArray(fields['sourceImg'])
			? fields['sourceImg']
			: [];
		const imageUrl = srcArr[0]?.url;
		if (!imageUrl) throw new Error("No image found in 'sourceImg' field");

		const prompt = (fields['chatgpt_prompt'] || fields['prompt'] || '').toString().trim();
		if (!prompt) throw new Error('Missing chatgpt_prompt field');

		const duration = parseInt(fields['duration'] || req.query.duration || '5', 10);
		const guidance_scale = parseFloat(fields['guidance_scale'] || req.query.guidance_scale || '0.5');
		const negative_prompt = (
			fields['negative_prompt'] ||
			req.query.negative_prompt ||
			'blur, distort, and low quality'
		).toString();

		function readDesired(nField) {
			if (typeof nField === 'number') return nField;
			if (typeof nField === 'string') return parseInt(nField, 10);
			if (nField && typeof nField === 'object' && typeof nField.name === 'string') return parseInt(nField.name, 10);
			return NaN;
		}
		const desiredRaw = req.query.n ?? fields['amount_outputs'] ?? fields['Amount outputs'] ?? '1';
		let desired = readDesired(desiredRaw);
		if (!Number.isFinite(desired) || desired < 1) desired = 1;
		if (desired > 8) desired = 8;

		const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || '900', 10)));
		const perTaskTimeoutMs = timeoutSec * 1000;
		const MAX_CONCURRENCY = 4;

		const taskIds = await Promise.all(
			Array.from({ length: desired }, () =>
				submitKling25TurboTask({ image: imageUrl, prompt, negative_prompt, duration, guidance_scale })
			)
		);
		console.log(`[kling25] submitting ${desired} tasks ->`, taskIds);

		const idBatches = chunk(taskIds, MAX_CONCURRENCY);
		const successes = [];
		const failures = [];

		for (const batch of idBatches) {
			const results = await Promise.allSettled(batch.map((id) => pollResult(id, perTaskTimeoutMs)));
			results.forEach((r, idx) => {
				const id = batch[idx];
				if (r.status === 'fulfilled') successes.push(...r.value);
				else failures.push({ id, error: r.reason?.message || String(r.reason) });
			});
		}

		if (!successes.length && failures.length) {
			throw new Error(
				`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`
			);
		}

		const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map((x) => ({ url: x.url })) : [];
		const newFiles = successes.map((url, i) => ({ url, filename: `kling25_${Date.now()}_${i}.mp4` }));
		const finalAttachments = [...existing, ...newFiles];

		const hadFailures = failures.length > 0;
		await patchAirtableRecord(baseId, tableIdOrName, recordId, {
			[fieldName]: finalAttachments,
			[statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : 'Success',
			[errField]: hadFailures
				? failures
						.map((f) => `${f.id}: ${f.error}`)
						.join(' | ')
						.slice(0, 1000)
				: '',
		});

		res.json({ ok: true, recordId, requested: desired, completed: successes.length, failed: failures.length });
	} catch (err) {
		console.error('[kling25] ERROR:', err.message);
		try {
			await patchAirtableRecord(baseId, tableIdOrName, recordId, { [errField]: err.message, [statusField]: 'Error' });
		} catch {}
		res.status(500).json({ ok: false, error: err.message });
	}
});

/* === WAN 2.2 ANIMATE (hardened, with table detector) === */

// Tables your automations might accidentally fire from.
// Add more tbl… IDs here if you insist on mixing triggers.
const KNOWN_TABLES = [
	'tblwcHLyoHVYauQBB', // 🎥 VID GEN WAN
	'tbliEm1efdgbRIFMb', // KLING 2.5 Turbo (example from your setup)
	'tblrTdaEKwrnLq1Jq', // IMG GEN (adjust if different)
];

// Tell us exactly where a record lives, or complain with facts.
async function assertRecordInTableOrExplain(baseId, expectedTbl, recId) {
	async function probe(tbl) {
		const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(
			tbl
		)}/${encodeURIComponent(recId)}?returnFieldsByFieldId=true`;
		const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
		return { ok: r.ok, status: r.status, text: await r.text() };
	}

	const first = await probe(expectedTbl);
	if (first.ok) return expectedTbl;

	for (const tbl of KNOWN_TABLES) {
		if (tbl === expectedTbl) continue;
		const p = await probe(tbl);
		if (p.ok) {
			throw Object.assign(new Error(`Record ${recId} is in table ${tbl}, not ${expectedTbl}.`), {
				code: 'WRONG_TABLE',
				actualTable: tbl,
			});
		}
	}

	throw Object.assign(new Error(`Record ${recId} not found in ${expectedTbl}. (${first.status}) ${first.text}`), {
		code: 'NOT_FOUND',
	});
}

async function submitWanAnimate({ image, mode, prompt, resolution, seed, video }) {
	const resp = await fetch('https://api.wavespeed.ai/api/v3/wavespeed-ai/wan-2.2/animate', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WAVESPEED_API_KEY}` },
		body: JSON.stringify({ image, mode, prompt, resolution, seed, video }),
	});

	if (!resp.ok) throw new Error(`Wavespeed submit failed ${resp.status} ${await resp.text()}`);
	const data = await resp.json();
	const id = data?.data?.id;
	if (!id) throw new Error(`Wavespeed submit returned no id: ${JSON.stringify(data)}`);
	return id;
}

app.get('/v1/automations/webhookWanAnimate', async (req, res) => {
	const baseId = req.query.baseId;
	const requestedTbl = 'tblwcHLyoHVYauQBB';
	const fieldName = 'fldahPs300jCTclSQ'; // generated_outputs (field ID)
	const statusField = 'fldZwTUp3mFnGjbGW'; // Status (field ID)
	const errField = 'fldQYd9OmUYU8Ja4y'; // err_msg (field ID)

	function cleanRecId(v) {
		if (!v) return '';
		const s = String(v)
			.trim()
			.replace(/^["']+|["']+$/g, '');
		const m = s.match(/rec[0-9A-Za-z]{14}/);
		return m ? m[0] : s;
	}
	const recordId = cleanRecId(req.query.recordId);

	try {
		if (!baseId || !recordId) {
			return res.status(400).json({ ok: false, error: 'baseId and recordId are required' });
		}
		if (!AIRTABLE_TOKEN || !WAVESPEED_API_KEY) {
			return res.status(500).json({ ok: false, error: 'Server missing AIRTABLE_TOKEN or WAVESPEED_API_KEY' });
		}

		// Figure out where this record actually lives (and fail with a clear message if it’s not here)
		let tableIdOrName;
		try {
			tableIdOrName = await assertRecordInTableOrExplain(baseId, requestedTbl, recordId);
		} catch (e) {
			console.error('[wan] GET record failed:', e.message);
			return res.status(422).json({ ok: false, error: e.message, code: e.code, actualTable: e.actualTable });
		}

		// Fetch with field IDs so we can preserve attachment ids
		const recUrl = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(
			tableIdOrName
		)}/${encodeURIComponent(recordId)}?returnFieldsByFieldId=true`;
		const recResp = await fetch(recUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
		const record = await recResp.json();
		const fields = record?.fields || {};

		// Flip to Generating
		await patchAirtableRecord(baseId, tableIdOrName, recordId, { [statusField]: 'Generating', [errField]: '' });

		// Inputs
		const refArr = Array.isArray(fields['fldfgQZEx9gu1IXtR'])
			? fields['fldfgQZEx9gu1IXtR']
			: Array.isArray(fields['sourceImg'])
			? fields['sourceImg']
			: [];
		const imageUrl = refArr[0]?.url;
		if (!imageUrl) throw new Error('No reference image found (sourceImg).');

		const vidAttach = Array.isArray(fields['fldAtJ5iexsu3QSc5']) ? fields['fldAtJ5iexsu3QSc5'] : [];
		const videoUrl =
			vidAttach[0]?.url ||
			(typeof fields['sourceVideoUrl'] === 'string' ? fields['sourceVideoUrl'] : '') ||
			(typeof fields['video'] === 'string' ? fields['video'] : '') ||
			req.query.video;
		if (!videoUrl) throw new Error('No source video found (sourceVideo attachment or sourceVideoUrl/text).');

		const prompt = (fields['fldruD65OYSnU76Jv'] || fields['chatgpt_prompt'] || req.query.prompt || '')
			.toString()
			.trim();
		if (!prompt) throw new Error('Missing chatgpt_prompt.');

		let mode = (fields['mode'] || req.query.mode || 'replace').toString().toLowerCase();
		if (mode !== 'replace' && mode !== 'animate') mode = 'replace';
		const resolution = (fields['resolution'] || req.query.resolution || '720p').toString();
		const seed = parseInt(fields['seed'] ?? req.query.seed ?? '-1', 10);

		// const durationChoice = fields['fld0903IezfdxheZl'] || fields['duration'] || '5';
		// const durationStr =
		// 	typeof durationChoice === 'object' && durationChoice?.name ? durationChoice.name : String(durationChoice);
		// const duration = parseInt(durationStr, 10) || 5;

		function readDesired(nField) {
			if (typeof nField === 'number') return nField;
			if (typeof nField === 'string') return parseInt(nField, 10);
			if (nField && typeof nField === 'object' && typeof nField.name === 'string') return parseInt(nField.name, 10);
			return NaN;
		}
		const desiredRaw = req.query.n ?? fields['fldyEoibZoFAAd5N9'] ?? fields['amount_outputs'] ?? '1';
		let desired = readDesired(desiredRaw);
		if (!Number.isFinite(desired) || desired < 1) desired = 1;
		if (desired > 8) desired = 8;

		const modelPicked = (fields['fldMXB312vy3JPTq3'] || fields['wan_model_to_use'] || '').toString();

		const timeoutSec = Math.max(60, Math.min(3600, parseInt(req.query.timeoutSec || '900', 10)));
		const perTaskTimeoutMs = timeoutSec * 1000;
		const MAX_CONCURRENCY = 4;

		// Submit WAN jobs
		const basePayload = { image: imageUrl, video: videoUrl, prompt, mode, resolution, seed };
		const taskIds = await Promise.all(Array.from({ length: desired }, () => submitWanAnimate(basePayload)));
		console.log(`[wan] model=${modelPicked || 'wan-2.2/animate'} submitting ${desired} ->`, taskIds);

		// Poll in batches
		const idBatches = chunk(taskIds, MAX_CONCURRENCY);
		const successes = [];
		const failures = [];
		for (const batch of idBatches) {
			const results = await Promise.allSettled(batch.map((id) => pollResult(id, perTaskTimeoutMs)));
			results.forEach((r, idx) => {
				const id = batch[idx];
				if (r.status === 'fulfilled') successes.push(...r.value);
				else failures.push({ id, error: r.reason?.message || String(r.reason) });
			});
			await sleep(1500);
		}
		if (!successes.length && failures.length) {
			throw new Error(
				`All tasks failed or timed out (${failures.length}/${desired}). Example: ${failures[0].id}: ${failures[0].error}`
			);
		}

		// Preserve existing attachments by id, append new
		const existing = Array.isArray(fields[fieldName]) ? fields[fieldName].map((x) => ({ id: x.id })) : [];
		const newFiles = successes.map((url, i) => ({ url, filename: `wan_${Date.now()}_${i}.mp4` }));
		const finalAttachments = [...existing, ...newFiles];

		const hadFailures = failures.length > 0;
		await patchAirtableRecord(baseId, tableIdOrName, recordId, {
			[fieldName]: finalAttachments,
			[statusField]: hadFailures ? `Partial Success (${successes.length}/${desired})` : 'Success',
			[errField]: hadFailures
				? failures
						.map((f) => `${f.id}: ${f.error}`)
						.join(' | ')
						.slice(0, 1000)
				: '',
		});

		res.json({
			ok: true,
			recordId,
			requested: desired,
			completed: successes.length,
			failed: failures.length,
			modelPicked,
		});
	} catch (err) {
		console.error('[wan] ERROR:', err?.message || err);
		try {
			await patchAirtableRecord(
				baseId,
				req.query.tableIdOrName || 'tblpTowzUx7zqnb1h',
				String(req.query.recordId || '')
					.trim()
					.replace(/^["']+|["']+$/g, ''),
				{ [errField]: String(err?.message || err), [statusField]: 'Error' }
			);
		} catch {}
		res.status(500).json({ ok: false, error: String(err?.message || err) });
	}
});

app.get('/v1/automations/wan/diagnose', async (req, res) => {
	const baseId = req.query.baseId;
	const tableId = req.query.tableIdOrName || 'tblpTowzUx7zqnb1h';
	const recRaw = (req.query.recordId || '').trim().replace(/^["']+|["']+$/g, '');
	const recId = (recRaw.match(/rec[0-9A-Za-z]{14}/) || [recRaw])[0];

	try {
		const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(
			tableId
		)}/${encodeURIComponent(recId)}?returnFieldsByFieldId=true`;
		const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
		const text = await r.text();
		res.status(r.status).json({
			ok: r.ok,
			baseId,
			tableIdOrName: tableId,
			recordId: recId,
			note: 'If ok=false and status=422, the record is NOT in this table.',
			airtableResponse: safeJson(text),
		});
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}

	function safeJson(t) {
		try {
			return JSON.parse(t);
		} catch {
			return t;
		}
	}
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`HTTP listening on ${PORT}`);
});
