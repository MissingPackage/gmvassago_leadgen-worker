/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env) {
		const { method, url } = request;
		const u = new URL(url);

		/************************************************************
		 * 1) HANDSHAKE WEBHOOK (GET) – verifica hub.challenge
		 ************************************************************/
		if (method === "GET" && u.pathname === "/webhook") {
			const mode = u.searchParams.get("hub.mode");
			const token = u.searchParams.get("hub.verify_token");
			const challenge = u.searchParams.get("hub.challenge");

			console.log("🔁 HANDSHAKE:", { mode, token, challenge });

			if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
				console.log("✅ Handshake OK");
				return new Response(challenge, { status: 200 });
			}
			console.log("❌ Handshake FAILED");
			return new Response("Forbidden", { status: 403 });
		}

		/************************************************************
		 * 2) RICEZIONE LEAD (POST)
		 ************************************************************/
		if (method === "POST" && u.pathname === "/webhook") {
			try {
				console.log("📥 POST ricevuto");

				const body = await request.json();
				console.log("🗂️  Body:", JSON.stringify(body, null, 2));

				const leadId = body?.entry?.[0]?.changes?.[0]?.value?.leadgen_id;
				console.log("🔍 leadgen_id:", leadId);

				if (!leadId) {
					console.log("⚠️  Nessun leadgen_id nel payload");
					return new Response("NO_LEAD_ID", { status: 200 });
				}

				/**************** 2a) Recupero dati lead ****************/
				const leadURL = `https://graph.facebook.com/v22.0/${leadId}?access_token=${env.FB_TOKEN}`;
				console.log("⬇️  GET Lead:", leadURL);

				let lead;
				try {
					const res = await fetch(leadURL);
					lead = await res.json();
					console.log("📑 Lead JSON:", JSON.stringify(lead, null, 2));
				} catch (err) {
					console.log("❌ Errore fetch lead:", err);
				}

				const name = lead?.field_data?.find(f => f.name === "full_name")?.values?.[0] ?? "";
				const phone = lead?.field_data?.find(f => f.name === "phone_number")?.values?.[0] ?? "";

				console.log("👤 Estratto:", { name, phone });

				/**************** 2b) Invio WhatsApp ****************/
				if (phone) {
					const waURL = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;
					const waBody = {
						messaging_product: "whatsapp",
						to: phone, // Usa il numero di telefono estratto
						type: "template",
						template: {
							name: env.TEMPLATE_NAME,
							language: { code: "en_US" }
						}
					};

					console.log("➡️  POST WhatsApp con telefono:", waURL);
					console.log("📝 Body:", JSON.stringify(waBody, null, 2));

					try {
						const waRes = await fetch(waURL, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${env.WABA_TOKEN}`,
								"Content-Type": "application/json"
							},
							body: JSON.stringify(waBody)
						});
						const waJson = await waRes.json();
						console.log("📨 WhatsApp response:", waJson);
					} catch (err) {
						console.log("❌ Errore invio WhatsApp con telefono:", err);
					}
				}

				// Test temporaneo: invio anche senza telefono
				const waURLFallback = `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_ID}/messages`;
				const waBodyFallback = {
					messaging_product: "whatsapp",
					to: '+393383231742', // Numero fallback
					type: "template",
					template: {
						name: env.TEMPLATE_NAME,
						language: { code: "en_US" }
					}
				};

				console.log("➡️  POST WhatsApp senza telefono:", waURLFallback);
				console.log("📝 Body:", JSON.stringify(waBodyFallback, null, 2));

				try {
					const waResFallback = await fetch(waURLFallback, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${env.WABA_TOKEN}`,
							"Content-Type": "application/json"
						},
						body: JSON.stringify(waBodyFallback)
					});
					const waJsonFallback = await waResFallback.json();
					console.log("📨 WhatsApp response senza telefono:", waJsonFallback);
				} catch (err) {
					console.log("❌ Errore invio WhatsApp senza telefono:", err);
				}

			} catch (err) {
				console.log("❌ Errore generale POST:", err);
			}

			// Rispondi 200 a Facebook comunque: evita pending
			return new Response("OK", { status: 200 });
		}

		/************************************************************
		 * 404 fallback
		 ************************************************************/
		return new Response("Not found", { status: 404 });
	}
}