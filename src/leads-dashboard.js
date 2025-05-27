// src/leads-dashboard.js
// Dashboard HTML e API per la gestione dei lead

export async function handleLeadsDashboard(request, env) {
    const url = new URL(request.url);
    const cookies = Object.fromEntries((request.headers.get('cookie') || '').split(';').map(c => c.trim().split('=')));
    const isLogin = url.pathname.endsWith('/login');
    const isLogged = cookies['ldash'] === env.ADMIN_KEY;

    // Login POST
    if (request.method === 'POST' && isLogin) {
        const form = await request.formData();
        const key = form.get('key')?.trim();
        if (key === env.ADMIN_KEY) {
            // Redirect HTTP 302 dopo login corretto
            return new Response(null, {
                status: 302,
                headers: {
                    'Set-Cookie': `ldash=${env.ADMIN_KEY}; Path=/; Max-Age=86400; SameSite=Lax`,
                    'Location': '/leads-dashboard'
                }
            });
        } else {
            return new Response(loginHtml('Chiave errata!'), { status: 401, headers: { 'Content-Type': 'text/html' } });
        }
    }

    // Se non loggato, mostra login
    if (!isLogged) {
        return new Response(loginHtml(), { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    const pendingList = await env.KV.list({ prefix: 'pending_lead:' });
    const followupList = await env.KV.list({ prefix: 'lead_followup:' });
    const followupMap = {};
    for (const k of followupList.keys) {
        const phone = k.name.replace('lead_followup:', '');
        try { followupMap[phone] = JSON.parse(await env.KV.get(k.name)); } catch { }
    }
    const leads = [];
    for (const k of pendingList.keys) {
        const dataRaw = await env.KV.get(k.name);
        if (!dataRaw) continue;
        let data;
        try { data = JSON.parse(dataRaw); } catch { continue; }
        const phone = data.phone;
        leads.push({
            phone,
            name: data.name || '',
            email: data.email || '',
            created: data.created || 0,
            sentFirst: data.sentFirst || false,
            erroreFinale: data.erroreFinale || '',
            retryCount: data.retryCount || 0,
            nextRetry: data.nextRetry || '',
            benvenutoMsgId: data.benvenutoMsgId || '',
            followup: followupMap[phone] || {}
        });
    }
    leads.sort((a, b) => b.created - a.created);
    const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Leads Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { font-family: system-ui, Arial, sans-serif; background: #f7f7fa; margin: 0; padding: 0; }
.container { max-width: 900px; margin: 32px auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 16px #0001; padding: 32px; }
h1 { text-align: center; color: #222; }
table { width: 100%; border-collapse: collapse; margin-top: 24px; }
th, td { padding: 8px 6px; border-bottom: 1px solid #eee; text-align: left; }
th { background: #f0f0f7; }
tr:hover { background: #f8f8ff; }
.btn { padding: 6px 14px; border: none; border-radius: 5px; margin: 0 2px; font-size: 1em; cursor: pointer; transition: background 0.2s; }
.btn-welcome { background: #25d366; color: #fff; }
.btn-f1 { background: #ffb300; color: #fff; }
.btn-f2 { background: #1976d2; color: #fff; }
.btn-del { background: #e53935; color: #fff; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
small { color: #888; }
</style>
</head>
<body>
<div class="container">
<h1>Leads Dashboard</h1>
<table>
<thead><tr><th>Nome</th><th>Telefono</th><th>Email</th><th>Creato</th><th>Stato</th><th>Azioni</th></tr></thead>
<tbody>
${leads.map(lead => {
        const f1 = lead.followup.sent1;
        const f2 = lead.followup.sent2;
        return `<tr>
<td>${lead.name}</td>
<td>${lead.phone}</td>
<td>${lead.email}</td>
<td><small>${new Date(lead.created).toLocaleString('it-IT')}</small></td>
<td>
${lead.erroreFinale ? `<span style='color:#e53935'>Errore: ${lead.erroreFinale}</span>` : lead.sentFirst ? 'Benvenuto inviato' : 'In attesa'}<br>
${f1 ? 'FollowUp1 inviato<br>' : ''}${f2 ? 'FollowUp2 inviato' : ''}
</td>
<td>
<button class="btn btn-welcome" onclick="sendAction('welcome','${lead.phone}')" ${lead.sentFirst ? 'disabled' : ''}>Benvenuto</button>
<button class="btn btn-f1" onclick="sendAction('f1','${lead.phone}')" ${f1 ? 'disabled' : ''}>FollowUp 1</button>
<button class="btn btn-f2" onclick="sendAction('f2','${lead.phone}')" ${f2 ? 'disabled' : ''}>FollowUp 2</button>
<button class="btn btn-del" onclick="sendAction('delete','${lead.phone}')">Elimina</button>
</td>
</tr>`;
    }).join('')}
</tbody>
</table>
</div>
<script>
function sendAction(action, phone) {
	const ok = confirm("Confermi l\'azione su ' + phone + '?");
	if (!ok) return;
	fetch('/lead-action', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, phone })
	})
	.then(res => res.json())
	.then(j => {
		alert(j.message || 'Operazione completata');
		location.reload();
	});
}
</script>
</body>
</html>`;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

export async function handleLeadAction(request, env, sendTemplate) {
    // Autenticazione tramite cookie della dashboard
    const cookies = Object.fromEntries((request.headers.get('cookie') || '').split(';').map(c => c.trim().split('=')));
    if (cookies['ldash'] !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: 'Accesso negato' }), { status: 401 });
    }

    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400 }); }
    const { action, phone } = body;
    if (!action || !phone) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400 });
    const leadKey = `pending_lead:${phone}`;
    const followupKey = `lead_followup:${phone}`;
    const dataRaw = await env.KV.get(leadKey);
    if (!dataRaw) return new Response(JSON.stringify({ error: 'Lead non trovato' }), { status: 404 });
    let data;
    try { data = JSON.parse(dataRaw); } catch { return new Response(JSON.stringify({ error: 'Lead corrotto' }), { status: 500 }); }
    if (action === 'welcome') {
        if (data.sentFirst) return new Response(JSON.stringify({ message: 'Benvenuto già inviato' }), { status: 200 });
        const leadInfo = { name: data.name || '', phone, email: data.email || '' };
        const msgId = await sendTemplate(env, phone, env.TEMPLATE_LEAD, [], leadInfo);
        data.sentFirst = true;
        data.benvenutoMsgId = msgId;
        data.sentFirstAt = Date.now();
        await env.KV.put(leadKey, JSON.stringify(data), { expirationTtl: 2_592_000 });
        return new Response(JSON.stringify({ message: 'Benvenuto inviato', msgId }), { status: 200 });
    }
    if (action === 'f1') {
        let state = {};
        try { state = JSON.parse(await env.KV.get(followupKey)) || {}; } catch { }
        if (state.sent1) return new Response(JSON.stringify({ message: 'FollowUp1 già inviato' }), { status: 200 });
        const msgId = await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP1, []); // <-- nessun parametro
        state.sent1 = true;
        state.sent1At = Date.now();
        await env.KV.put(followupKey, JSON.stringify(state), { expirationTtl: 2_592_000 });
        return new Response(JSON.stringify({ message: 'FollowUp1 inviato', msgId }), { status: 200 });
    }
    if (action === 'f2') {
        let state = {};
        try { state = JSON.parse(await env.KV.get(followupKey)) || {}; } catch { }
        if (state.sent2) return new Response(JSON.stringify({ message: 'FollowUp2 già inviato' }), { status: 200 });
        const msgId = await sendTemplate(env, phone, env.TEMPLATE_FOLLOWUP2, []); // <-- nessun parametro
        state.sent2 = true;
        state.sent2At = Date.now();
        await env.KV.put(followupKey, JSON.stringify(state), { expirationTtl: 2_592_000 });
        return new Response(JSON.stringify({ message: 'FollowUp2 inviato', msgId }), { status: 200 });
    }
    if (action === 'delete') {
        await env.KV.delete(leadKey);
        await env.KV.delete(followupKey);
        return new Response(JSON.stringify({ message: 'Lead eliminato' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Azione non valida' }), { status: 400 });
}

function loginHtml(errorMsg) {
    return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>Login Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { background: #f7f7fa; font-family: system-ui, Arial, sans-serif; }
.loginbox { max-width: 340px; margin: 80px auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 16px #0001; padding: 32px; }
h2 { text-align: center; color: #222; }
input[type=password] { width: 100%; padding: 10px; margin: 16px 0 24px 0; border: 1px solid #ccc; border-radius: 6px; font-size: 1.1em; }
button { width: 100%; background: #1976d2; color: #fff; border: none; border-radius: 6px; padding: 10px; font-size: 1.1em; cursor: pointer; }
.err { color: #e53935; text-align: center; margin-bottom: 12px; }
</style></head><body>
<div class="loginbox">
<h2>Login Dashboard</h2>
${errorMsg ? `<div class='err'>${errorMsg}</div>` : ''}
<form method="POST" action="/leads-dashboard/login">
<input type="password" name="key" placeholder="Chiave di accesso" autocomplete="current-password" required autofocus>
<button type="submit">Entra</button>
</form>
</div></body></html>`;
}
