# Lead-to-WhatsApp Automation

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.dev)
[![WhatsApp Cloud API](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=green)](https://developers.facebook.com/docs/whatsapp/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Made with ❤️](https://img.shields.io/badge/Made%20with-%E2%9D%A4-red)](https://gmvassago.it)

> **Zero-cost, zero-maintenance** pipeline that greets every new Facebook/Instagram Lead-Ads contact with a personalised WhatsApp message—powered by Cloudflare Workers and Meta APIs.

---

### ✨ Features

|                           |                                                                            |
| ------------------------- | -------------------------------------------------------------------------- |
| **Always-Free Hosting**   | Cloudflare Workers free tier (100k req/day) with automatic TLS 1.3         |
| **Instant Lead Capture**  | Webhook on `leadgen` delivers the lead **from any present or future form** |
| **Personalised WhatsApp** | Sends a template message (`lead_benvenuto`) using WhatsApp Cloud API       |
| **Long-Lived Tokens**     | System-User token (no expiry) for WhatsApp; Page token auto-refreshable    |
| **No Dev-Ops**            | `wrangler deploy` — that’s it. No servers, no cron cert renewals           |

---

## 📐 Logical Flow

```
Facebook / Instagram  →  Webhook (Cloudflare)  →  Fetch full lead
Lead Ads               (hub.verify_token OK)     name / phone extracted
                                │                          │
                                └──────▶ waitUntil ────────┘
                                            │
                                            ▼
                                WhatsApp Business Cloud API
                                   Send template message
```

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/leadgen-worker.git
cd leadgen-worker
npm install -g wrangler   # if not installed
```

### 2. Meta Setup

| Step                    | Portal                                | Action                                                                                                                                   |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **App**                 | _developers.facebook.com_             | Create **Business** app → add **WhatsApp** + **Webhooks** products                                                                       |
| **System-User**         | _Business Settings → System Users_    | Generate permanent token with:<br>`whatsapp_business_messaging` `whatsapp_business_management` `leads_retrieval` `pages_read_engagement` |
| **Page Token**          | Graph API Explorer                    | `GET /me/accounts` → copy Page **access_token** (`pages_manage_metadata`, `leads_retrieval`)                                             |
| **Webhook**             | App → Webhooks                        | Product **Page** → Callback URL `https://<sub>.workers.dev/webhook`<br>Verify token = `leadgen2025` → subscribe **leadgen**              |
| **Install App on Page** | Graph API Explorer                    | `POST /<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen` using **Page Token**                                                         |
| **WhatsApp Number**     | App → WhatsApp                        | Add real number → copy **Phone Number ID**                                                                                               |
| **Template**            | Business Manager → WhatsApp Templates | Create & approve `lead_benvenuto`                                                                                                        |

### 3. Cloudflare Secrets

```bash
wrangler secret put VERIFY_TOKEN          # es. leadgen2025
wrangler secret put FB_TOKEN              # EAAB...
wrangler secret put WABA_TOKEN            # EAAJ...  (system-user)
wrangler secret put WHATSAPP_PHONE_ID     # 115678901234567
wrangler secret put TEMPLATE_NAME         # ed. lead_welcome
```

### 4. Deploy

```bash
wrangler deploy
wrangler tail     # watch logs
```

Create a **test lead** in the [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing/) – your phone should receive the WhatsApp greeting in seconds.

---

## 🛠️ Project Structure

```
leadgen-worker/
├─ src/
│  └─ index.js        # Cloudflare Worker
├─ wrangler.toml      # Worker configuration
└─ README.md
```

---

## 🔄 Token Refresh (optional)

- **System-User token** is permanent.
- **Page token** lasts 60 days – add a Workers Cron:

```toml
[triggers]
crons = ["0 0 1 */2 *"]   # every 60 days
```

…and call the token-extend endpoint, updating `FB_TOKEN` in KV or a new secret.

---

## 📝 License

MIT © 2025 GMVassago Team / Cristiano Mazzella Solution Architect
