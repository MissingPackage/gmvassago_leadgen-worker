/**********************************************************************
 * Cloudflare Worker – Lead capture + WhatsApp relay bidirezionale
 * versione DELAY 2025-06-17
 **********************************************************************/

export default {

	/* =================================================================
	 * HTTP entry-point: webhook
	 * ===============================================================*/
	async fetch(request, env) {
		const { method, url } = request;
		const u = new URL(url);

		/* --- 1) HANDSHAKE ------------------------------------------- */
		if (method === 'GET' && u.pathname === '/webhook') {
			const mode = u.searchParams.get('hub.mode');
			const verifyTok = u.searchParams.get('hub.verify_token');
			const challenge = u.searchParams.get('hub.challenge');

			console.log('👉 HANDSHAKE', { mode, verifyTok, challenge });

			if (mode === 'subscribe' && verifyTok === env.VERIFY_TOKEN) {
				console.log('✅ Handshake OK');
				return new Response(challenge, { status: 200 });
			}
			console.warn('❌ Handshake FAILED');
			return new Response('Forbidden', { status: 403 });
		}

		/* --- 2) POST webhook ---------------------------------------- */
		if (method === 'POST' && u.pathname === '/webhook') {
			let body;
			try { body = await request.json(); }
			catch (err) {
				console.error('⚠️ Body non-JSON:', err);
				return new Response('BAD_REQUEST', { status: 400 });
			}
			console.log('📨 Webhook payload:', JSON.stringify(body, null, 2));

			try {
				const change = body?.entry?.[0]?.changes?.[0];
				if (!change) { console.warn('⚠️ Nessun change'); return ok(); }

				/* -- leadgen -------------------------------------------- */
				const leadId = change.value?.leadgen_id;
				if (leadId) {
					await handleLeadDelayed(leadId, env);
					return ok();
				}

				/* -- messaggi / status ---------------------------------- */
				const msg = change.value?.messages?.[0];
				const status = change.value?.statuses?.[0];        // non gestito ora
				if (msg) await handleMessage(msg, env);
				else if (status) console.log('📶 EVENT status:', status);
				else console.log('ℹ️ Evento ignorato');
			} catch (err) { console.error('❌ POST handler error:', err); }

			return ok();
		}

		return new Response('Not found', { status: 404 });
		function ok() { return new Response('OK', { status: 200 }); }
	},

	/* =================================================================
	 * CRON: ogni 5 min invia i lead scaduti
	 * ===============================================================*/
	async scheduled(event, env, ctx) {
		const now = Date.now();
		const list = await env.KV.list({ prefix: 'pending_lead:' });
		console.log('⏰ Cron: pending =', list.keys.length);

		for (const k of list.keys) {
			const data = JSON.parse(await env.KV.get(k.name));
			if (!data) continue;

			if (now - data.created >= data.delay) {
				console.log(`🚀 INVIO ritardato a ${data.phone} (${data.name})`);
				await sendTemplate(env, data.phone, env.TEMPLATE_LEAD, []);
				await env.KV.delete(k.name);
			}
		}
	}
};

/* ===================================================================
 * 1. SALVA LEAD in pending con delay random
 * =================================================================*/
async function handleLeadDelayed(leadId, env) {
	const url = `https://graph.facebook.com/v22.0/${leadId}?access_token=${env.FB_TOKEN}`;
	console.log('⬇️ FETCH lead:', url);

	const lead = await fetch(url).then(r => r.json());
	console.log('📑 Lead JSON:', JSON.stringify(lead, null, 2));

	const rawPhone =
		lead?.field_data?.find(x => x.name === 'numero_di_telefono')?.values?.[0] ??
		lead?.field_data?.find(x => x.name === 'phone_number')?.values?.[0] ?? '';
	const name =
		lead?.field_data?.find(x => x.name === 'nome_e_cognome')?.values?.[0] ??
		lead?.field_data?.find(x => x.name === 'full_name')?.values?.[0] ?? '';

	const phone = normalizePhone(rawPhone);
	console.log('👤 Lead estratto:', { name, phone });

	if (!phone) { console.warn('⚠️ Lead senza telefono'); return; }

	/*-- delay 30-90 min --*/
	const delayMs = 30 * 60 * 1000 + Math.floor(Math.random() * 60 * 60 * 1000);
	await env.KV.put(`pending_lead:${phone}`, JSON.stringify({
		phone, name,
		created: Date.now(),
		delay: delayMs
	}), { expirationTtl: 2_592_000 });

	/* salva anche nome per uso futuro (notify) */
	await env.KV.put(`name:${phone}`, name, { expirationTtl: 2_592_000 });

	console.log(`🕒 Lead in pending (${Math.round(delayMs / 60000)} min)`);
}

/* ===================================================================
 * 2. RELAY messaggi
 * =================================================================*/
async function handleMessage(msg, env) {
	if (msg.type !== 'text' || !msg.text?.body) {
		console.log('⤵️ Messaggio non-testo ignorato:', msg.type); return;
	}

	const USER = normalizePhone(msg.from);
	const OWNER = normalizePhone(env.OWNER_PHONE);

	/* deduplica */
	if (await env.KV.get(`seen:${msg.id}`)) return;
	await env.KV.put(`seen:${msg.id}`, '1', { expirationTtl: 86_400 });

	/* -- A) inbound utente -> Paolo ------------------------------ */
	if (USER !== OWNER) {
		const savedName = await env.KV.get(`name:${USER}`);
		const displayName = msg.profile?.name || savedName || USER;

		console.log(`➡️ Nuovo msg da ${displayName} (${USER})`);

		const tplId = await sendTemplate(env, env.OWNER_PHONE, env.TEMPLATE_NOTIFY, [
			{ type: 'text', text: displayName },
			{ type: 'text', text: USER },
			{ type: 'text', text: msg.text.body.slice(0, 120) }
		]);

		if (tplId)
			await env.KV.put(`relay:${tplId}`, USER, { expirationTtl: 2_592_000 });

		await env.KV.put(`lead:${USER}`, Date.now().toString(), { expirationTtl: 2_592_000 });
		return;
	}

	/* -- B) Paolo → utente (deve citare) ------------------------- */
	const ctxId = msg.context?.id;
	if (!ctxId) { console.log('⏩ Paolo senza reply – ignorato'); return; }

	const userPhone = await env.KV.get(`relay:${ctxId}`);
	if (!userPhone) { console.log('❔ mapping assente per', ctxId); return; }

	const last = Number(await env.KV.get(`lead:${userPhone}`)) || 0;
	if (Date.now() - last > 23.5 * 3_600_000) {
		await sendTemplate(env, userPhone, env.TEMPLATE_FOLLOWUP_24H, []);
		console.log('🔓 finestra riaperta follow_up 24h');
	}
	await env.KV.put(`lead:${userPhone}`, Date.now().toString(), { expirationTtl: 2_592_000 });

	console.log(`⬅️ Relay Paolo→utente ${userPhone}:`, msg.text.body);
	await sendText(env, userPhone, msg.text.body);
}

/* ===================================================================
 * 3. SEND TEMPLATE / TEXT
 * =================================================================*/
async function sendTemplate(env, to, name, parameters) {
	const url = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;

	let components = [];
	if (name === 'lead_benvenuto' && env.MEDIA_ID_LEAD) {
		components.push({
			type: 'header',
			parameters: [{ type: 'image', image: { id: env.MEDIA_ID_LEAD } }]
		});
	}
	if (parameters.length)
		components.push({ type: 'body', parameters });

	const body = {
		messaging_product: 'whatsapp',
		to,
		type: 'template',
		template: {
			name,
			language: { code: 'it' },
			...(components.length && { components })
		}
	};

	console.log('➡️ POST template', name, '→', to);
	const j = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.WABA_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	}).then(r => r.json());
	console.log('📬 template resp:', JSON.stringify(j));
	return j?.messages?.[0]?.id ?? null;
}

async function sendText(env, to, text) {
	const url = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;
	const body = {
		messaging_product: 'whatsapp',
		to,
		type: 'text',
		preview_url: true,
		text: { body: text }
	};
	const j = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.WABA_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	}).then(r => r.json());
	console.log('📬 text resp:', JSON.stringify(j));
}

/* ===================================================================
 * 4. PHONE helper
 * =================================================================*/
function normalizePhone(raw = '') {
	raw = raw.trim();
	if (raw.startsWith('+')) return raw;
	if (raw.startsWith('00')) return '+' + raw.slice(2);

	let n = raw.replace(/\D/g, '');
	if (n.length === 10 && n.startsWith('3')) return '+39' + n;
	if (n.length === 12 && n.startsWith('39')) return '+' + n;
	if (n.length < 10) { console.warn('⚠️ Tel corto:', raw); return ''; }
	return '+' + n;
}
