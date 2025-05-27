/**********************************************************************
 * Cloudflare Worker – Lead capture + WhatsApp relay bidirezionale
 * versione DELAY + FOLLOWUP AUTO 2025-06-18
 * 
 * KEYS UTILIZZATE:
 * pending_lead:{phone} - Lead in attesa di invio/followup (se sentFirst: false)
 * lead:{phone} - Lead che hanno ricevuto risposta almeno una volta
 * lead_followup:{phone} - Stato follow-up per un lead
 * name:{phone} - Nome associato al numero
 * email:{phone} - Email associata al numero
 * relay:{messageId} - Mapping tra msg_id di notifica e numero utente
 * seen:{messageId} - Deduplica messaggi già processati
 * lead_counter - Contatore totale lead ricevuti (valore numerico)
 **********************************************************************/

// Numeri di telefono per test istantaneo WhatsApp (aggiungi qui i tuoi numeri di test)
const TEST_PHONES = [
	//'+393383231742', // esempio: sostituisci con i tuoi numeri
	'+393773925575',
	'+393939439138',
	'+358458588800',
	'+393318343142',
	// '+393471234567',
];

import { handleLeadAction, handleLeadsDashboard } from './leads-dashboard.js';
import { analyzeWhatsAppError, formatErrorMessage, getRetryStrategy } from './whatsapp-utils.js';

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

		// --- DASHBOARD stats (solo con autenticazione) --------------
		if (method === 'GET' && u.pathname === '/stats') {

			// Raccogli tutte le statistiche
			try {
				const totalLeads = parseInt(await env.KV.get("lead_counter") || "0");
				const pendingList = await env.KV.list({ prefix: 'pending_lead:' });
				const leadList = await env.KV.list({ prefix: 'lead:' });

				// Per ogni lead pending, recuperiamo lo stato
				const pendingLeads = [];
				for (const k of pendingList.keys) {
					const dataRaw = await env.KV.get(k.name);
					if (!dataRaw) continue;
					try {
						const data = JSON.parse(dataRaw);
						const phone = data.phone;

						// Ottieni stato follow-up
						let followupState = {};
						try {
							const followupRaw = await env.KV.get(`lead_followup:${phone}`);
							if (followupRaw) followupState = JSON.parse(followupRaw);
						} catch { }

						// Mostra anche errori e retry info
						pendingLeads.push({
							phone: data.phone,
							name: data.name || "",
							email: data.email || "",
							created: data.created || 0,
							age: Math.round((Date.now() - data.created) / (1000 * 60 * 60 * 24)),
							sentFirst: data.sentFirst || false,
							sent1: followupState.sent1 || false,
							sent2: followupState.sent2 || false,
							retryCount: data.retryCount || 0,
							nextRetry: data.nextRetry || null,
							erroreFinale: data.erroreFinale || null
						});
					} catch { }
				}

				// Raccogli statistiche
				const stats = {
					totalLeads,
					pendingCount: pendingList.keys.length,
					respondedCount: leadList.keys.length,
					pendingLeads: pendingLeads,
					generatedAt: new Date().toISOString()
				};

				return new Response(JSON.stringify(stats, null, 2), {
					status: 200,
					headers: {
						'Content-Type': 'application/json'
					}
				});
			} catch (err) {
				return new Response(JSON.stringify({ error: err.message || 'Errore nel recupero statistiche' }), {
					status: 500,
					headers: {
						'Content-Type': 'application/json'
					}
				});
			}
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
				else if (status) {
					console.log('📶 EVENT status:', status);
					// Notifica OWNER se status fallito per messaggio benvenuto
					if (status.status === 'failed' || status.status === 'undelivered') {
						// Recupera il lead associato a questo messaggio (cerca tra pending_lead)
						const list = await env.KV.list({ prefix: 'pending_lead:' });
						for (const k of list.keys) {
							const dataRaw = await env.KV.get(k.name);
							if (!dataRaw) continue;
							let data;
							try { data = JSON.parse(dataRaw); } catch { continue; }
							if (data.benvenutoMsgId && data.benvenutoMsgId === status.id) {
								// Analizza errore WhatsApp
								const errorAnalysis = analyzeWhatsAppError(status);
								// Calcola strategia retry
								const retryInfo = getRetryStrategy(errorAnalysis, data);
								// Formatta messaggio errore per OWNER
								const motivo = formatErrorMessage(errorAnalysis, retryInfo);
								const n = data.name || '-';
								const t = data.phone || '-';
								const e = data.email || '-';
								await sendTemplate(env, env.OWNER_PHONE, 'notifica_lead_fallito', [
									{ type: 'text', text: n },
									{ type: 'text', text: t },
									{ type: 'text', text: e },
									{ type: 'text', text: motivo }
								]);
								console.log('🚨 Notifica fallimento WhatsApp inviata a OWNER per', t, '|', motivo);
								// Aggiorna retryCount e nextRetry se necessario
								if (retryInfo.shouldRetry) {
									data.retryCount = retryInfo.retryCount;
									data.nextRetry = retryInfo.nextRetry;
									await env.KV.put(k.name, JSON.stringify(data), { expirationTtl: 2_592_000 });
									console.log('🔁 Retry WhatsApp schedulato per', t, 'tra', Math.round(retryInfo.delay / 3600000), 'ore');
								} else {
									// Errore permanente: marca errore e rimuovi dal pending dopo notifica
									data.erroreFinale = errorAnalysis.desc;
									await env.KV.put(k.name, JSON.stringify(data), { expirationTtl: 2_592_000 });
									// (opzionale) elimina subito dal pending
									// await env.KV.delete(k.name);
									console.log('🛑 Lead', t, 'marcato come errore permanente:', errorAnalysis.desc);
								}
								break;
							}
						}
					}
				}
				else console.log('ℹ️ Evento ignorato');
			} catch (err) { console.error('❌ POST handler error:', err); }

			return ok();
		}

		// --- MASS WELCOME + CLEANUP endpoint (autenticato) -----------
		if (method === 'POST' && u.pathname === '/mass-welcome-cleanup') {
			const pendingList = await env.KV.list({ prefix: 'pending_lead:' });
			const followupList = await env.KV.list({ prefix: 'lead_followup:' });
			let sent = 0, alreadySent = 0, errors = 0;
			let results = [];
			for (const k of pendingList.keys) {
				const dataRaw = await env.KV.get(k.name);
				if (!dataRaw) continue;
				let data;
				try { data = JSON.parse(dataRaw); } catch { errors++; continue; }
				const phone = data.phone;
				if (!phone) { errors++; continue; }
				let status = 'already_sent';
				let msgId = null;
				if (!data.sentFirst) {
					const leadInfo = { name: data.name || '', phone, email: data.email || '' };
					try {
						msgId = await sendTemplate(env, phone, env.TEMPLATE_LEAD, [], leadInfo);
						status = msgId ? 'sent' : 'send_error';
						sent++;
					} catch {
						status = 'send_error';
						errors++;
					}
				} else {
					alreadySent++;
				}
				results.push({ phone, name: data.name || '', email: data.email || '', status, msgId });
			}
			// Cleanup tutte le chiavi pending_lead e lead_followup
			for (const k of pendingList.keys) { await env.KV.delete(k.name); }
			for (const k of followupList.keys) { await env.KV.delete(k.name); }
			return new Response(JSON.stringify({
				total: pendingList.keys.length,
				sent,
				alreadySent,
				errors,
				results,
				cleaned: pendingList.keys.length + followupList.keys.length
			}, null, 2), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// --- LEAD DASHBOARD HTML (delegato) ---------------------------
		if (method === 'GET' && u.pathname === '/leads-dashboard') {
			return await handleLeadsDashboard(request, env);
		}
		// --- LEAD ACTION API (delegato) -------------------------------
		if (method === 'POST' && u.pathname === '/lead-action') {
			return await handleLeadAction(request, env, sendTemplate);
		}

		// --- LEADS DASHBOARD LOGIN (delegato) ---------------------------
		if (
			(u.pathname === '/leads-dashboard/login' && (method === 'GET' || method === 'POST'))
		) {
			return await handleLeadsDashboard(request, env);
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
		const currentHour = new Date(now + tzOffset * 3600 * 1000).getUTCHours();

		const ms1 = 1000 * 60 * 60 * (parseFloat(env.FOLLOWUP1_HOURS) || 24); // default 24h
		const ms2 = 1000 * 60 * 60 * 24 * (parseFloat(env.FOLLOWUP2_DAYS) || 15); // default 15d
		const maxAge = 1000 * 60 * 60 * 24 * (parseFloat(env.CLEANUP_DAYS) || 20); // default 20d

		console.log(`📊 Configurazione follow-up:
		🕒 FOLLOWUP1_HOURS: ${parseFloat(env.FOLLOWUP1_HOURS) || 24}h (${Math.round(ms1 / 3600000)}h)
		🕒 FOLLOWUP2_DAYS: ${parseFloat(env.FOLLOWUP2_DAYS) || 15}d (${Math.round(ms2 / 86400000)}d)
		🕒 CLEANUP_DAYS: ${parseFloat(env.CLEANUP_DAYS) || 20}d
		🕒 ORA CORRENTE (UTC+${tzOffset}): ${currentHour}:00
		🕒 ORA FOLLOWUP: ${hourToSend}:00`);

		const totalLeads = parseInt(await env.KV.get("lead_counter") || "0");
		const list = await env.KV.list({ prefix: 'pending_lead:' });
		console.log(`⏰ Scheduled follow-up: ${list.keys.length} pending / ${totalLeads} totali`);
		console.log('⏰ Scheduled follow-up: pending_lead:', list.keys.map(k => k.name));

		let countProcessed = 0;
		let countSkipped = 0;
		let countSentWelcome = 0;
		let countSentFollowup1 = 0;
		let countSentFollowup2 = 0;
		let countCleaned = 0;
		let countErrors = 0;

		for (const k of list.keys) {
			countProcessed++;
			const dataRaw = await env.KV.get(k.name);
			if (!dataRaw) {
				console.warn(`⚠️ Nessun dato per ${k.name}`);
				countErrors++;
				continue;
			}

			let data;
			try {
				data = JSON.parse(dataRaw);
			} catch (err) {
				console.error(`❌ Errore parsing JSON per ${k.name}:`, err);
				countErrors++;
				continue;
			}

			if (!data.phone) {
				console.warn(`⚠️ Lead senza telefono per ${k.name}`);
				countErrors++;
				continue;
			}

			const phone = data.phone;
			const name = data.name || "";
			const email = data.email || "";
			const created = data.created || 0;
			const leadAge = Math.round((now - created) / (1000 * 60 * 60 * 24));

			console.log(`🔍 PROCESSING ${k.name}: età=${leadAge}d, nome="${name}", sentFirst=${!!data.sentFirst}`);

			// STOP se lead ha risposto almeno una volta
			const leadKey = await env.KV.get(`lead:${phone}`);
			if (leadKey) {
				console.log(`🛑 Lead ${phone} già risposto, cancello pending e followup`);
				await env.KV.delete(k.name);
				await env.KV.delete(`lead_followup:${phone}`);
				countSkipped++;
				continue;
			}

			// Cleanup lead con errore permanente più vecchi di 3 giorni
			if (data.erroreFinale && now - created > 3 * 24 * 60 * 60 * 1000) {
				console.log(`🗑️ Cleanup lead errore permanente ${phone} (${leadAge} giorni, errore: ${data.erroreFinale})`);
				await env.KV.delete(k.name);
				await env.KV.delete(`lead_followup:${phone}`);
				countCleaned++;
				continue;
			}

			// 1) Primo invio (benvenuto) se non ancora inviato
			if (!data.sentFirst) {
				console.log(`🚀 INVIO benvenuto a ${phone} (${name})`);
				const leadInfo = { name, phone, email };
				const msgId = await sendTemplate(env, phone, env.TEMPLATE_LEAD, [], leadInfo);
				console.log(`📬 Risposta sendTemplate (benvenuto) per ${phone}:`, msgId);
				data.sentFirst = true;
				data.benvenutoMsgId = msgId;
				data.sentFirstAt = Date.now();
				await env.KV.put(k.name, JSON.stringify(data), { expirationTtl: 2_592_000 });
				countSentWelcome++;
			}

			// 2) Follow-up 1 e 2 (solo se mai risposto e all'orario giusto)
			let state = {};
			try { state = JSON.parse(await env.KV.get(`lead_followup:${phone}`)) || {}; } catch { }
			const sent1 = !!state.sent1, sent2 = !!state.sent2;
			console.log(`📈 Follow-up status per ${phone}: sent1=${sent1}, sent2=${sent2}, hourNow=${currentHour}, followupHour=${hourToSend}`);

			// Follow-up 1 (24h dopo, all'ora specificata)
			if (data.sentFirst && !sent1 && now - created > ms1) {
				if (currentHour === hourToSend) {
					const resp = await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP1, []); // <-- nessun parametro
					console.log(`📬 Risposta sendTemplate (followup1) per ${phone}:`, resp);
					state.sent1 = true;
					state.sent1At = Date.now();
					await env.KV.put(`lead_followup:${phone}`, JSON.stringify(state), { expirationTtl: 2_592_000 });
					console.log(`🚩 Primo follow-up inviato a ${phone} (${name})`);
					countSentFollowup1++;
				} else {
					console.log(`⏰ Follow-up 1 pronto per ${phone} ma attende ora corretta (${currentHour} vs ${hourToSend})`);
					countSkipped++;
				}
			}

			// Follow-up 2 (15gg dopo, all'ora specificata)
			if (data.sentFirst && !sent2 && now - created > ms2) {
				if (currentHour === hourToSend) {
					const resp = await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP2, []); // <-- nessun parametro
					console.log(`📬 Risposta sendTemplate (followup2) per ${phone}:`, resp);
					state.sent2 = true;
					state.sent2At = Date.now();
					await env.KV.put(`lead_followup:${phone}`, JSON.stringify(state), { expirationTtl: 2_592_000 });
					console.log(`🚩 Secondo follow-up inviato a ${phone} (${name})`);
					countSentFollowup2++;
				} else {
					console.log(`⏰ Follow-up 2 pronto per ${phone} ma attende ora corretta (${currentHour} vs ${hourToSend})`);
					countSkipped++;
				}
			}

			// 3) Cleanup dei lead vecchi (dopo maxAge)
			if (now - created > maxAge) {
				console.log(`🗑️ Cleanup lead vecchio ${phone} (${leadAge} giorni)`);
				await env.KV.delete(k.name);
				await env.KV.delete(`lead_followup:${phone}`);
				countCleaned++;
			}
		}

		console.log(`📊 RIEPILOGO SCHEDULED:
- Lead processati: ${countProcessed}/${list.keys.length}
- Welcome inviati: ${countSentWelcome}
- Follow-up 1 inviati: ${countSentFollowup1}
- Follow-up 2 inviati: ${countSentFollowup2}
- Lead ripuliti: ${countCleaned}
- Lead skippati: ${countSkipped}
- Errori: ${countErrors}`);
	}
};

/* ===================================================================
 * 1. SALVA LEAD in pending con delay random
 * =================================================================*/
async function handleLeadDelayed(leadId, env) {
	// Incrementa contatore totale lead
	let totalLeadCount = parseInt(await env.KV.get("lead_counter") || "0");
	totalLeadCount++;
	await env.KV.put("lead_counter", totalLeadCount.toString());
	console.log(`📊 Lead totali ricevuti: ${totalLeadCount}`);

	const url = `https://graph.facebook.com/v22.0/${leadId}?access_token=${env.FB_TOKEN}`;
	console.log(`⬇️ FETCH lead`);

	const lead = await fetch(url).then(r => r.json()).catch(err => {
		console.error(`❌ Errore fetch lead da Facebook: ${err.message || err}`);
		return null;
	});

	if (!lead || lead.error) {
		console.error(`❌ Lead non valido o errore API Facebook: ${JSON.stringify(lead?.error || 'Nessuna risposta')}`);
		return;
	}

	console.log(`📑 Lead JSON: ${JSON.stringify(lead, null, 2)}`);

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

	// Verifica della validità del numero WhatsApp
	const isValidPhone = phone && phone.length >= 10 && phone.startsWith('+');

	// LOG FORMATTATO
	console.log(`👤 Lead estratto: Nome = "${name || '-'}" | Telefono = "${phone || '-'}" ${isValidPhone ? '✅' : '❌'} | Email = "${email || '-'}"`);

	// 1. INVIO EMAIL SUBITO se presente
	if (email) {
		const EMAIL_WELCOME_TEMPLATE = getEmailWelcomeTemplate(env);

		// Invia email tramite Resend
		const emailRes = await sendEmailResend(
			env,
			email,
			EMAIL_WELCOME_TEMPLATE.subject,
			EMAIL_WELCOME_TEMPLATE.html,
			EMAIL_WELCOME_TEMPLATE.text
		);
		console.log(`📧 Invio email Resend: ${JSON.stringify(emailRes)}`);
	} else {
		console.log(`⚠️ Lead senza email, nessuna mail inviata`);
	}

	// 2. WhatsApp: metti in pending con delay
	if (!isValidPhone) {
		console.warn(`⚠️ Lead senza telefono valido: "${rawPhone}" → "${phone}"`);
		// Salva comunque nome e email se presenti
		if (name) await env.KV.put(`lead_name:${totalLeadCount}`, name, { expirationTtl: 2_592_000 });
		if (email) await env.KV.put(`lead_email:${totalLeadCount}`, email, { expirationTtl: 2_592_000 });
		return;
	}

	// Controlla se già esiste un pending con questo numero
	const existingLeadRaw = await env.KV.get(`pending_lead:${phone}`);
	if (existingLeadRaw) {
		const existingLead = JSON.parse(existingLeadRaw);
		if (existingLead.erroreFinale) {
			console.log(`⛔ Lead ${phone} già marcato errore permanente: ${existingLead.erroreFinale}`);
			return;
		}
		console.log(`⚠️ Lead duplicato! Telefono ${phone} già presente in pending_lead`);
	}

	// ELIMINA IL DELAY: invio immediato per tutti
	let delayMs = 0;
	let sentFirst = false;
	let benvenutoMsgId = null;
	console.log(`🚀 Invio WhatsApp immediato a ${phone}`);
	const leadInfo = { name, phone, email };
	benvenutoMsgId = await sendTemplate(env, phone, env.TEMPLATE_LEAD, [], leadInfo);
	sentFirst = true;
	console.log(`📬 Messaggio benvenuto inviato subito: ${benvenutoMsgId}`);

	// Salva il lead con tutte le info rilevanti
	await env.KV.put(`pending_lead:${phone}`, JSON.stringify({
		phone, name, email,
		created: Date.now(),
		delay: delayMs,
		sentFirst,
		benvenutoMsgId,
		leadId // Aggiungiamo anche l'ID originale del lead
	}), { expirationTtl: 2_592_000 });

	await env.KV.put(`name:${phone}`, name, { expirationTtl: 2_592_000 });
	await env.KV.put(`email:${phone}`, email, { expirationTtl: 2_592_000 });

	console.log(`🕒 Lead in pending (0 min) [INVIO IMMEDIATO]`);
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

	console.log(`⬅️ Relay Paolo→utente ${userPhone}: ${msg.text.body}`);
	await sendText(env, userPhone, msg.text.body);
}

/* ===================================================================
 * 3. SEND TEMPLATE / TEXT
 * =================================================================*/
async function sendTemplate(env, to, name, parameters, leadInfo = null) {
	if (!to || !name) {
		console.error(`❌ Errore invio template: parametri mancanti (to: ${to}, name: ${name})`);
		return null;
	}

	// Sanitizza il numero di telefono
	to = normalizePhone(to);
	if (!to || to.length < 10) {
		console.error(`❌ Numero di telefono non valido: ${to}`);
		return null;
	}

	// Aggiunge un parametro vuoto se non ce ne sono per evitare problemi con alcuni template
	parameters = parameters || [];

	const url = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;

	let components = [];
	// Aggiungi header SOLO se sia MEDIA_ID_LEAD che il template lo richiede
	if (name === env.TEMPLATE_LEAD && env.MEDIA_ID_LEAD && env.TEMPLATE_LEAD_HAS_HEADER === '1') {
		components.push({
			type: 'header',
			parameters: [{ type: 'image', image: { id: env.MEDIA_ID_LEAD } }]
		});
	}
	if (parameters.length) {
		components.push({ type: 'body', parameters });
	}

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

	console.log(`➡️ POST template "${name}" → ${to}`);

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.WABA_TOKEN}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			console.error(`❌ Errore HTTP invio template: ${response.status} ${response.statusText}`);
		}

		const j = await response.json();
		console.log(`📬 template resp:`, JSON.stringify(j));

		// Se errore invio lead, notifica Paolo (OWNER) tramite template dedicato
		if ((name === env.TEMPLATE_LEAD || name === "lead_benvenuto") && j.error) {
			const motivo = j.error.message || j.error.code || 'Errore generico';
			const n = leadInfo?.name || "-";
			const t = leadInfo?.phone || "-";
			const e = leadInfo?.email || "-";

			// Previeni ricorsione infinita evitando di reinviare se siamo già in notifica
			if (name !== 'notifica_lead_fallito') {
				await sendTemplate(env, env.OWNER_PHONE, 'notifica_lead_fallito', [
					{ type: 'text', text: n },
					{ type: 'text', text: t },
					{ type: 'text', text: e },
					{ type: 'text', text: motivo }
				]);
				console.log(`🚨 Template notifica_lead_fallito inviato a OWNER per errore: ${motivo}`);
			}
		}

		return j?.messages?.[0]?.id ?? null;
	} catch (err) {
		console.error(`❌ Errore invio template ${name}: ${err.message || err}`);
		return null;
	}
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
	console.log(`📬 text resp: ${JSON.stringify(j)}`);
}

/* ===================================================================
 * 4. SEND EMAIL (Resend)
 * =================================================================*/

async function sendEmailResend(env, to, subject, html, text = '') {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000); // 8s soft timeout

	try {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from: `${env.RESEND_FROM_NAME || 'GM Vassago'} <${env.RESEND_FROM_EMAIL}>`,
				to: Array.isArray(to) ? to : [to], subject, html, ...(text ? { text } : {})
			}),
			signal: controller.signal
		});
		clearTimeout(timeout);
		console.log(`📧 Invio mail a: ${to} | subject: ${subject}`);
		const result = await res.json();
		console.log(`📧 Email Resend: ${JSON.stringify(result)}`);
		return result;
	} catch (err) {
		console.error(`❌ Errore invio mail: ${err}`);
		return null;
	}
}

function getEmailWelcomeTemplate(env) {
	const fromEmail = env.RESEND_FROM_EMAIL;
	const whatsapp = env.OWNER_PHONE ? `https://wa.me/${env.OWNER_PHONE.replace(/\D/g, '')}` : '';
	const site = 'https://gmvassago.it';

	return {
		subject: "Benvenuto in GM Vassago – La tua avventura inizia ora",
		html: `
      <div style="font-family: Arial, Helvetica, sans-serif; color: #222; max-width: 540px;">
        <h2 style="color: #1f1f1f;">Benvenuto in GM Vassago</h2>
        <p>
          Gentile avventuriero,<br><br>
          ti ringraziamo per averci contattato.<br>
          <br>
          Se desideri partecipare alle nostre <b>sessioni di Dungeons & Dragons</b> o vuoi migliorare le tue capacità narrative con la <b>GM Vassago Academy</b>, sei nel posto giusto.<br>
          <br>
          Siamo a tua disposizione per qualsiasi domanda o approfondimento: puoi rispondere direttamente a questa email</a>.
        </p>
        <p>
          <b>Contattaci subito anche su WhatsApp: </b>
          <a href="${whatsapp}" style="color: #25D366; font-weight: bold;">Scrivi su WhatsApp a GM Vassago!</a>
        </p>
        <p>
          <b>Perché scegliere GM Vassago?</b><br>
          • Esperienza professionale e personalizzata<br>
          • Materiale ufficiale e supporto dedicato<br>
          • Community esclusiva per giocatori e Game Master<br>
        </p>
        <p>
          <b>Vuoi fissare una chiamata o una prima sessione conoscitiva?</b><br>
          Rispondi direttamente a questa email o manda un messaggio WhatsApp, ti ricontatteremo al più presto.<br>
        </p>
        <br>
        <p style="font-size: 1.05em; font-weight: bold; color: #222; margin-bottom: 0; margin-top: 32px;">
          GM Vassago: Deluxe Gaming for Deluxe Players
        </p>
        <img src="${env.LOGO_URL}" alt="GMV Logo" style="display:block; margin: 24px auto 8px auto; max-width:220px; border-radius:10px;">
        <hr style="margin: 16px 0 12px 0;">
        <p style="font-size: 0.96em; color: #666; margin: 0;">
          I servizi di GM Vassago sono riservati ai maggiorenni.<br>
          <a href="${site}" style="color: #1769aa;">gmvassago.it</a>
        </p>
        <p style="font-size: 0.90em; color: #888; margin-top: 16px;">
          Questa email è stata inviata automaticamente in seguito a una richiesta di contatto.<br>
          Se pensi di aver ricevuto questo messaggio per errore, puoi ignorarlo in tutta sicurezza.
        </p>
      </div>
    `,
		text: `
Benvenuto in GM Vassago

Gentile avventuriero,

ti ringraziamo per averci contattato.

Se desideri partecipare alle nostre sessioni di Dungeons & Dragons o vuoi migliorare le tue capacità narrative con la GM Vassago Academy, sei nel posto giusto.

Siamo a tua disposizione per qualsiasi domanda o approfondimento.
Puoi rispondere a questa email (${fromEmail}) oppure contattarci su WhatsApp: ${whatsapp}

Perché scegliere GM Vassago?
• Esperienza professionale e personalizzata
• Materiale ufficiale e supporto dedicato
• Community esclusiva per giocatori e Game Master

Vuoi fissare una chiamata o una prima sessione conoscitiva?
Rispondi direttamente a questa email o manda un messaggio WhatsApp, ti ricontatteremo al più presto.

GM Vassago: Deluxe Gaming for Deluxe Players

---

I servizi di GM Vassago sono riservati ai maggiorenni.
${site}

Questa email è stata inviata automaticamente in seguito a una richiesta di contatto.
Se pensi di aver ricevuto questo messaggio per errore, puoi ignorarlo in tutta sicurezza.
`
	};
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
