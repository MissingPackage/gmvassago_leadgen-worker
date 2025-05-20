/**********************************************************************
 * Cloudflare Worker – Lead capture + WhatsApp relay bidirezionale
 * versione DELAY + FOLLOWUP AUTO 2025-06-18
 **********************************************************************/

export default {

	async fetch(request, env) {
		const { method, url } = request;
		const u = new URL(url);

		// --- 1) HANDSHAKE -------------------------------------------
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

		// --- 2) POST webhook ----------------------------------------
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

				// -- leadgen --------------------------------------------
				const leadId = change.value?.leadgen_id;
				if (leadId) {
					await handleLeadDelayed(leadId, env);
					return ok();
				}

				// -- messaggi / status ----------------------------------
				const msg = change.value?.messages?.[0];
				const status = change.value?.statuses?.[0];
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
	 * CRON: ogni 5 min invia i lead scaduti e gestisce follow-up
	 * ===============================================================*/
	async scheduled(event, env, ctx) {
		const now = Date.now();
		const tzOffset = 3; // UTC+3
		const hourToSend = parseInt(env.FOLLOWUP_HOUR || '19', 10);

		const ms1 = 1000 * 60 * 60 * (parseFloat(env.FOLLOWUP1_HOURS) || 24); // default 24h
		const ms2 = 1000 * 60 * 60 * 24 * (parseFloat(env.FOLLOWUP2_DAYS) || 15); // default 15d
		const maxAge = 1000 * 60 * 60 * 24 * (parseFloat(env.CLEANUP_DAYS) || 20); // default 20d

		const list = await env.KV.list({ prefix: 'pending_lead:' });
		console.log(`⏰ Scheduled follow-up: ${list.keys.length} pending`);

		for (const k of list.keys) {
			const data = JSON.parse(await env.KV.get(k.name));
			if (!data || !data.phone) continue;

			const phone = data.phone;
			const name = data.name || "";
			const email = data.email || "";
			const created = data.created || 0;

			const hourNow = new Date(now + tzOffset * 3600 * 1000).getUTCHours();

			// STOP se lead ha risposto almeno una volta
			if (await env.KV.get(`lead:${phone}`)) {
				await env.KV.delete(k.name);
				await env.KV.delete(`lead_followup:${phone}`);
				continue;
			}

			// 1) Primo invio ritardato 30-90min (lead_benvenuto)
			if (now - created >= data.delay && !data.sentFirst) {
				console.log(`🚀 INVIO ritardato a ${phone} (${name})`);
				const leadInfo = { name, phone, email };
				const ok = await sendTemplate(env, phone, env.TEMPLATE_LEAD, [], leadInfo);
				data.sentFirst = true;
				await env.KV.put(k.name, JSON.stringify(data), { expirationTtl: 2_592_000 });
			}

			// 2) Follow-up 1 (solo se mai risposto, mai mandato followup1, e all'orario giusto)
			let state = {};
			try { state = JSON.parse(await env.KV.get(`lead_followup:${phone}`)) || {}; } catch { }
			const sent1 = !!state.sent1, sent2 = !!state.sent2;

			// Soglia per il primo follow-up: dopo ms1 (default 24h) e solo all'ora giusta
			if (!sent1 && now - created > ms1 && hourNow === hourToSend) {
				await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP1, [{ type: "text", text: name }]);
				state.sent1 = true;
				await env.KV.put(`lead_followup:${phone}`, JSON.stringify(state), { expirationTtl: 2_592_000 });
				console.log(`🚩 Primo follow-up inviato a ${phone} (${name})`);
			}
			// Soglia per il secondo follow-up: dopo ms2 (default 15d) e solo all'ora giusta
			if (!sent2 && now - created > ms2 && hourNow === hourToSend) {
				await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP2, [{ type: "text", text: name }]);
				state.sent2 = true;
				await env.KV.put(`lead_followup:${phone}`, JSON.stringify(state), { expirationTtl: 2_592_000 });
				console.log(`🚩 Secondo follow-up inviato a ${phone} (${name})`);
			}

			// 3) Cleanup dei lead vecchi (dopo maxAge)
			if (now - created > maxAge) {
				await env.KV.delete(k.name);
				await env.KV.delete(`lead_followup:${phone}`);
				console.log(`🗑️ Cleanup lead vecchio ${phone}`);
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
	const email =
		lead?.field_data?.find(f => f.name === 'email')?.values?.[0] ??
		lead?.field_data?.find(f => f.name === 'e-mail')?.values?.[0] ?? '';

	const phone = normalizePhone(rawPhone);

	// LOG FORMATTATO
	console.log(`👤 Lead estratto: Nome = "${name || '-'}" | Telefono = "${phone || '-'}" | Email = "${email || '-'}"`);

	if (!phone) { console.warn('⚠️ Lead senza telefono'); return; }

	// delay 30-90 min (in ms)
	const delayMs = 30 * 60 * 1000 + Math.floor(Math.random() * 60 * 60 * 1000);
	await env.KV.put(`pending_lead:${phone}`, JSON.stringify({
		phone, name, email,
		created: Date.now(),
		delay: delayMs,
		sentFirst: false
	}), { expirationTtl: 2_592_000 });

	// Salva anche nome e email per lookup (notifiche future)
	await env.KV.put(`name:${phone}`, name, { expirationTtl: 2_592_000 });
	await env.KV.put(`email:${phone}`, email, { expirationTtl: 2_592_000 });

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
		const savedEmail = await env.KV.get(`email:${USER}`);
		const displayName = msg.profile?.name || savedName || USER;

		console.log(`➡️ Nuovo msg da ${displayName} (${USER}) - Email: ${savedEmail || "-"}`);

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
async function sendTemplate(env, to, name, parameters, leadInfo = null) {
	const url = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;

	let components = [];
	// Aggiungi header SOLO se sia MEDIA_ID_LEAD che il template lo richiede
	if (name === 'lead_benvenuto' && env.MEDIA_ID_LEAD && env.TEMPLATE_LEAD_HAS_HEADER === '1') {
		components.push({
			type: 'header',
			parameters: [{ type: 'image', image: { id: env.MEDIA_ID_LEAD } }]
		});
	}
	if (parameters.length)
		components.push({ type: 'body', parameters });

	const template = {
		name,
		language: { code: 'it' }
	};
	if (components.length > 0) {
		template.components = components;
	}

	const body = {
		messaging_product: 'whatsapp',
		to,
		type: 'template',
		template
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

	// Se errore invio lead, notifica Paolo (OWNER) tramite template dedicato
	if (name === "lead_benvenuto" && j.error) {
		const motivo = j.error.message || 'Errore generico';
		const n = leadInfo?.name || "-";
		const t = leadInfo?.phone || "-";
		const e = leadInfo?.email || "-";
		await sendTemplate(env, env.OWNER_PHONE, 'notifica_lead_fallito', [
			{ type: 'text', text: n },
			{ type: 'text', text: t },
			{ type: 'text', text: e },
			{ type: 'text', text: motivo }
		]);
		console.log('🚨 Template notifica_lead_fallito inviato a OWNER');
	}

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
