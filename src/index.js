/**********************************************************************
 * Cloudflare Worker – Lead capture + WhatsApp relay bidirezionale
 * versione DEBUG 2025-06-16
 **********************************************************************/
export default {
	async fetch(request, env) {
		const { method, url } = request;
		const u = new URL(url);

		/* ───── 1) VERIFICA WEBHOOK (GET) ───────────────────────────── */
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

		/* ───── 2) EVENTI POST ─────────────────────────────────────── */
		if (method === 'POST' && u.pathname === '/webhook') {
			let body;
			try {
				body = await request.json();
			} catch (err) {
				console.error('⚠️ Body non-JSON:', err);
				return new Response('BAD_REQUEST', { status: 400 });
			}
			console.log('📨 Webhook payload:', JSON.stringify(body, null, 2));

			try {
				const change = body?.entry?.[0]?.changes?.[0];
				if (!change) {
					console.warn('⚠️ Nessun change nella payload');
					return new Response('OK', { status: 200 });
				}

				/* 2a – leadgen */
				const leadId = change.value?.leadgen_id;
				if (leadId) {
					console.log('🔔 EVENT leadgen_id:', leadId);
					await handleLead(leadId, env);
					return new Response('OK', { status: 200 });
				}

				/* 2b – messages / statuses (v>=15 include entrambi) */
				const msg = change.value?.messages?.[0];
				const status = change.value?.statuses?.[0];   // non usato ora

				if (msg) {
					console.log('💬 EVENT message:', msg.id);
					await handleMessage(msg, env);
				} else if (status) {
					console.log('📶 EVENT status:', status);
					// eventualmente loggare / salvare
				} else {
					console.log('ℹ️ Evento ignorato (no msg/status/leadgen)');
				}
			} catch (err) {
				console.error('❌ Error in POST handler:', err);
			}
			return new Response('OK', { status: 200 });   // evita retry FB
		}

		return new Response('Not found', { status: 404 });
	}
};

/* ===================================================================
 * FUNZIONI  –  LEAD
 * =================================================================*/
async function handleLead(leadId, env) {
	try {
		const url = `https://graph.facebook.com/v22.0/${leadId}?access_token=${env.FB_TOKEN}`;
		console.log('⬇️ FETCH lead:', url);

		const res = await fetch(url);
		const lead = await res.json();
		console.log('📑 Lead JSON:', JSON.stringify(lead, null, 2));

		const rawPhone =
			lead?.field_data?.find(f => f.name === 'numero_di_telefono')?.values?.[0] ??
			lead?.field_data?.find(f => f.name === 'phone_number')?.values?.[0] ?? '';

		const phone = normalizePhone(rawPhone);
		console.log('📞 Telefono estratto:', phone);

		if (phone) {
			await sendTemplate(env, phone, env.TEMPLATE_LEAD, []);
			await env.KV.put(`lead:${phone}`, Date.now().toString(), { expirationTtl: 2_592_000 });
			console.log('✅ Lead – template inviato a', phone);
		} else {
			console.warn('⚠️ Lead senza telefono');
		}
	} catch (err) {
		console.error('❌ handleLead error:', err);
	}
}

/* ===================================================================
 * FUNZIONI  –  MESSAGGI
 * =================================================================*/
async function handleMessage(msg, env) {
	try {
		if (msg.type !== 'text' || !msg.text?.body) {
			console.log('⤵️ Messaggio non-testo ignorato:', msg.type);
			return;
		}

		const USER = normalizePhone(msg.from);
		const OWNER = normalizePhone(env.OWNER_PHONE);

		/* deduplica */
		if (await env.KV.get(`seen:${msg.id}`)) {
			console.log('🔂 Duplicate msg.id', msg.id);
			return;
		}
		await env.KV.put(`seen:${msg.id}`, '1', { expirationTtl: 86_400 });

		/* ------- A) inbound utente -> cliente ------- */
		if (USER !== OWNER) {
			console.log(`➡️ Relay: utente ${USER} → cliente ${OWNER}`);

			const tplId = await sendTemplate(env, env.OWNER_PHONE, env.TEMPLATE_NOTIFY, [
				{ type: 'text', text: msg.profile?.name || USER },
				{ type: 'text', text: USER },
				{ type: 'text', text: msg.text.body.slice(0, 120) }
			]);

			// Salva la mappatura usando l'ID del template appena inviato
			if (tplId) {
				await env.KV.put(`relay:${tplId}`, USER, { expirationTtl: 2_592_000 });
			}

			await env.KV.put(`lead:${USER}`, Date.now().toString(), { expirationTtl: 2_592_000 });
			return;
		}

		/* ------- B) inbound cliente (reply) -> utente ------- */
		const ctxId = msg.context?.id;
		if (!ctxId) {
			console.log('⏩ Messaggio del cliente NON in reply – ignorato');
			return;
		}

		const userPhone = await env.KV.get(`relay:${ctxId}`);
		if (!userPhone) {
			console.log('❔ reply senza mapping relay:', ctxId);
			return;
		}

		const last = Number(await env.KV.get(`lead:${userPhone}`)) || 0;
		if (Date.now() - last > 23.5 * 3_600_000) {
			console.log('⏰ >24h – invio follow_up');
			await sendTemplate(env, userPhone, env.TEMPLATE_FOLLOWUP_24H, []);
		}
		await env.KV.put(`lead:${userPhone}`, Date.now().toString(), { expirationTtl: 2_592_000 });

		console.log(`⬅️ Relay: cliente → utente ${userPhone}`);
		await sendText(env, userPhone, msg.text.body);
	} catch (err) {
		console.error('❌ handleMessage error:', err);
	}
}

/* ===================================================================
 * HELPERS
 * =================================================================*/
async function sendTemplate(env, to, name, parameters) {
	const url = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;
	const body = {
		messaging_product: 'whatsapp',
		to,
		type: 'template',
		template: {
			name,
			language: { code: 'it' },
			...(parameters.length && {
				components: [{ type: 'body', parameters }]
			})
		}
	};
	console.log('➡️ POST template', name, '→', to);
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.WABA_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	const j = await res.json();
	console.log('📬 template response:', JSON.stringify(j));

	// Restituisci l'ID del messaggio se presente
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
	console.log('➡️ POST text →', to, ':', text);
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.WABA_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	const j = await res.json();
	console.log('📬 text response:', JSON.stringify(j));
}

function normalizePhone(raw = '') {
	return raw.replace(/\D/g, '');  // solo cifre
}
