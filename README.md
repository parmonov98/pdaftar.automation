# pDaftar Javob — automation.pdaftar.uz

Instagram sales assistant for small shops in Uzbekistan, built on Meta's models.

- **Answers comments and DMs in seconds**, in Uzbek or Russian, with the shop's **real prices and stock** from its pDaftar catalog.
  It never invents a price: every number in a reply is checked against the catalog before it can be sent.
- **Customer sends a photo** of a product → the vision model finds that product in the catalog.
- **Customer sends a voice note**: Muse Voice Transcribe turns it into text and the same grounded pipeline answers. If it can't be understood, a person gets it.
- **Promo Reels from the shop's own products.** SAM 3.1 finds the product in the owner's phone photo, Muse Image puts it in a clean studio scene, and Muse writes the caption. The video is rendered and posted as a Reel to the shop's **own** Instagram account.
- **Comments under a published Reel** are answered with exactly the products in that Reel.
- **Safe by default:**
  - it never messages anyone first;
  - complaints and "operator" requests go to a person;
  - drafts wait for approval until the shop turns on auto-send;
  - safe mode restricts real sends to allowlisted test accounts.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026), Startup track, theme "Build for Your World".

## How it uses Meta's models

| Step | Model (Meta Model API) |
|---|---|
| Understand the message (intent, product, language, phone/name) | `muse-spark-1.3` |
| Photo questions: "is this available?" → match against catalog photos | `muse-spark-1.3` (vision) |
| Grounded reply in the customer's language | `muse-spark-1.3` |
| Find and crop the product in a phone photo | `sam-3.1` |
| Clean studio scene around the exact product | `muse-image-1.0` (edits, product passed in `images[]`) |
| Reel caption + hashtags | `muse-spark-1.3` |
| Voice notes in DMs (very common in Uzbekistan) → text, then the normal grounded reply | `muse-voice-transcribe-1.0` |

**Two reply engines** (`REPLY_ENGINE`):
- `pipeline`: fixed steps (understand → search → reply).
- `agent`: Muse Spark calls the tools itself (`search_catalog`, `get_product`, `place_order`, `handoff`) with OpenAI-style tool calling.

Both share the same hard guards:
- prices are grounded in the catalog;
- products and stock counts the owner hid stay hidden;
- orders are placed only with a name and phone the customer really wrote;
- comments can't place orders.

Customer messages are never sent to the discounted "contributor" variants, which Meta may train on. The code refuses them.

## Architecture

```
Instagram ──webhook──▶ /webhooks/instagram (signature check, dedupe)
                          │ enqueue
                          ▼
                 SQLite job queue ──▶ reply lane:  understand → catalog → reply → grounding check → send | draft
                                  └─▶ render lane: SAM 3.1 → Muse Image → caption → ffmpeg Reel → publish
                          ▲
pDaftar integration API ──┘  (catalog, stock, orders; per-shop token)
Web app (React) ── /api ── inbox, Reels studio, playground, settings
```

- `api/`: Node 22+, Fastify, SQLite (better-sqlite3), ffmpeg (ffmpeg-static), @napi-rs/canvas for text overlays.
- `web/`: Vite + React 19, in Uzbek, Russian and English.
- pDaftar is reached only through its integration API (`/api/integration/automation/*`), authenticated with a per-shop token the owner issues in pDaftar.

## Run locally

```bash
npm install
cp .env.example api/.env    # fill in ENCRYPTION_KEY (openssl rand -base64 32)
npm run build -w web
cd api && npx tsx --env-file=.env src/main.ts   # http://localhost:8095
```

`AI_PROVIDER=mock` runs the whole pipeline without keys (deterministic stand-in). Set `AI_PROVIDER=meta` and `META_API_KEY` to use Meta's models.

## Tests

```bash
npm test -w api     # webhooks, grounding, safe mode, comment-on-Reel, render → publish
npm test -w web
```

## Instagram setup

1. Create a Meta app with the **Instagram API with Instagram Login** product.
2. Add `https://automation.pdaftar.uz/auth/instagram/callback` as an OAuth redirect URI.
3. Set the webhook callback to `https://automation.pdaftar.uz/webhooks/instagram` with the verify token from the env. Subscribe to the `comments` and `messages` fields.
4. Scopes:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`
   - `instagram_business_manage_comments`
   - `instagram_business_content_publish`
5. Standard access works for accounts with a role on the app. Serving other shops needs App Review + Business Verification.

## What was built during the hackathon

Startup track rules require us to separate new work from the existing product.

**New, built during the event (Oct 26 – Nov 4, 2026). Everything in this repository** (first commit: 2026-10-26 16:48 ET, after kickoff):
- Instagram webhook intake, the job queue, and safe mode / draft approval;
- the grounded reply engine on Muse Spark: intent, catalog lookup, price-grounding check, hand-off;
- photo matching with Muse Spark vision;
- voice-note transcription with Muse Voice Transcribe;
- the promo Reel pipeline: SAM 3.1 crop → Muse Image scene → Muse Spark caption → rendered Reel → Instagram publishing;
- answering comments under a Reel with that Reel's products;
- the web app: inbox, Reels studio, playground, settings.

On the pDaftar side, the integration API (per-shop token, catalog read, order create) was also built during the event: pdaftar.backend PR #2366, Oct 27.

**Existing assets reused (disclosed):**
- `api/assets/music/pdaftar-bed.m4a`: pDaftar's own original 15-second instrumental (no third-party samples, made September 2026).
- The Roboto fonts (Apache 2.0).

**Existing before the event (not part of the entry):** the pDaftar app itself. That is the shop's catalog, prices, stock and order inbox, which this project reads from and writes orders into.
