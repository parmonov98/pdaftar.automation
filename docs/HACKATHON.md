# Meta Global AI Developer Hackathon: submission pack

Track: **Startup**. Theme: **Build for Your World**. Deadline: **Nov 4, 2026, 9:00 PM ET** (Nov 5, 07:00 Tashkent). Plan to submit on Nov 4, Tashkent daytime.

## Official rules that shape this entry (read in the owner's Chrome, 2026-10-27)

- Themes: "Build for Your World" (ours) / "Push the Frontier".
- **The repo must be public.** Teams have at most 4 people.
- **Startups may build on existing products**, but must clearly identify what is new. **The demo may show only what was built during the event**, or the entry risks disqualification. See README → "What was built during the hackathon".
- Judging:
  - stage 1 is pass/fail: fits a theme and uses Meta models;
  - stage 2 weights: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25%;
  - the top 5 per track get live finals on Nov 9.
- Bonus prizes we can aim for:
  - Best Creative $5K (Muse Image) — our Reels;
  - Most Viral $20K (X post until Nov 8);
  - Best Agentic $5K.
- Anti-projects include "basic RAG" and "simple image analyzers". We are neither: a multi-model pipeline with grounding checks and real actions.
- One submission, made by an active employee of the startup (the "Representative"), listing every member.
- License: none is required. Meta and CV get a non-exclusive licence to show the work; we keep the IP.

## Owner checklist (needs your accounts)

- [ ] Claim the $150 Meta Model API credits (form in the Oct 26 Cerebral Valley email). Add a card (there is a pre-auth hold) and set the spend limit to $150. *(A Mac session was asked to fill the form; it won't enter card details.)*
- [ ] Create a Model API key. Put it in `~/.config/pdaftar-automation/env` on the VPS as `META_API_KEY=…`, set `AI_PROVIDER=meta`, then run `systemctl --user restart pdaftar-automation`.
- [ ] Check every model with one command: `cd ~/pdaftar/pdaftar.automation/api && node --env-file=$HOME/.config/pdaftar-automation/env dist/meta-check.js`. It tests chat, vision, SAM 3.1, Muse Image and Voice Transcribe, and never prints the key.
- [ ] Create a Meta developer app with **Instagram API with Instagram Login**:
  - Redirect URI: `https://automation.pdaftar.uz/auth/instagram/callback`.
  - Webhook URL: `https://automation.pdaftar.uz/webhooks/instagram`, with the verify token from `IG_WEBHOOK_VERIFY_TOKEN` in the env file. Fields: `comments`, `messages`.
  - Add @pdaftar.uz and pdaftar_uz as app roles. Put `IG_APP_ID` and `IG_APP_SECRET` in the env file and restart.
- [ ] Merge pdaftar.backend PR #2366 (needs a human click). Then set `AUTOMATION_INTEGRATION_ENABLED=true` on dev-api and point `PDAFTAR_API_BASE_URL` back to dev-api.
- [ ] **Make github.com/parmonov98/pdaftar.automation public** before submitting (required).
- [ ] Record the 3-minute video. Show only the new work; pDaftar appears only as "the catalog we read from".

## Submission form answers (draft, paste into the CV form)

- **Team name:** pDaftar
- **Track:** Startups Track
- **Problem statement:** Build for Your World
- **Public GitHub repository:** https://github.com/parmonov98/pdaftar.automation
- **Project description:** pDaftar Javob answers every Instagram comment, DM, photo and voice note for small shops in Uzbekistan in seconds, using the shop's real prices and stock from pDaftar. It never invents a price, it hands hard cases to the owner, and it turns the shop's products into promo Reels published to the shop's own Instagram. Comments under those Reels are answered with exactly the products shown.
- **Use of Meta products:**
  - Muse Spark 1.3: understands each comment or DM (intent, product, language, phone/name) and writes the grounded reply in Uzbek or Russian;
  - Muse Spark vision: matches a customer's photo against the shop's catalog photos;
  - Muse Voice Transcribe: turns voice notes into text;
  - SAM 3.1: finds and crops the product in the owner's phone photo;
  - Muse Image: places that exact product in a clean studio scene for the Reel;
  - Muse Spark: writes the Reel caption;
  - the Instagram Platform API (Meta): comments, DMs and Reel publishing.
- **Why Meta's models matter:** the whole loop is one family of models: understanding mixed Uzbek/Russian text, photos and voice; segmenting real-world product photos; generating clean product imagery. Running it all through one API lets a small shop get a sales assistant and a content studio at a cost that fits Uzbek SMB budgets. The SAM 3.1 + Muse Image pair is what turns a cluttered counter photo into a usable ad without the product being redrawn.

## Write-up (draft)

**pDaftar Javob: an Instagram sales assistant that knows the shop's real prices.**

In Uzbekistan, a large share of small retail happens in Instagram DMs and comments. Every Reel brings dozens of "narxi qancha?" ("how much?") and "bormi?" ("do you have it?"). Sellers answer hours later or never, and the sale is lost. Generic chatbots don't know the shop's prices or stock, and they invent answers.

pDaftar is a bookkeeping and inventory app used by thousands of Uzbek shops. It already holds each shop's catalog, prices and stock. pDaftar Javob connects that catalog to Instagram using Meta's models:

1. **Grounded answers.** Muse Spark reads the comment or DM and finds the product in the catalog, then writes a reply in the customer's language: Uzbek Latin, Uzbek Cyrillic or Russian. A hard check rejects any reply containing a price that isn't in the catalog. When unsure, it hands the conversation to the owner.
2. **Photo questions.** A customer sends a screenshot. Muse Spark's vision compares it with the catalog photos and answers about that exact product.
3. **Promo Reels from the shop's own products.**
   - SAM 3.1 finds the product in the owner's phone photo.
   - Muse Image places that exact product in a clean studio scene.
   - Muse Spark writes the caption.
   - The Reel is rendered and published to the shop's own Instagram account.
4. **The loop closes.** Comments under a published Reel are answered with exactly the products in that Reel. A confirmed order lands in pDaftar.

**Safety by design:**
- it never messages anyone first;
- prices are never invented;
- the owner's "hide stock count" and "hidden product" settings are respected;
- drafts need approval until the owner turns on auto-send;
- customer data never goes to models that train on inputs.

**Why it matters:** sellers recover lost sales without hiring. The catalog they already keep in pDaftar becomes their sales assistant.

## 3-minute demo script

| Time | Shot |
|---|---|
| 0:00–0:20 | The problem: a real shop Reel with unanswered "narxi?" comments. |
| 0:20–0:45 | pDaftar app: the shop's catalog (prices, stock). Sign in to automation.pdaftar.uz with the shop token. |
| 0:45–1:20 | Playground: "Qora futbolka narxi qancha?" → grounded answer in under 3 seconds. Then a Russian question, then a photo question. Show the matched product and the intent. |
| 1:20–2:10 | Reels studio: pick 2 products → "Yangi keldi" → SAM 3.1 crop + Muse Image scene → rendered Reel → publish to @pdaftar.uz. |
| 2:10–2:40 | From the tester account, comment "narxi?" under that Reel → reply appears with that product. DM "cola bormi?" → answer. A complaint goes to "Sizga topshirildi". |
| 2:40–3:00 | Safety + impact: never DMs first, no invented prices, owner approval. Closing line. |

## Demo footage (one command)

After the Meta key is installed (so the footage shows real model output):

```bash
node scripts/record-demo.mjs https://automation.pdaftar.uz <file-with-shop-token> ./demo-footage
```

It records four 1280×720 scenes in a real browser:
1. text questions in Uzbek and Russian;
2. a photo question and a recorded voice note;
3. the Reels studio rendering a Reel;
4. the inbox.

Cut them together with a 15-second intro (the problem) and outro (impact); target 3:00.

## X post draft (Most Viral bonus; post from the pDaftar account, tag the hackathon)

> Small shops in Uzbekistan sell through Instagram DMs, and every Reel brings dozens of "narxi qancha?" ("how much?").
>
> We built pDaftar Javob on Meta's models:
> 🧠 Muse Spark answers with the shop's REAL prices from pDaftar (never invented)
> 🎤 Voice notes → Muse Voice Transcribe
> 📸 "Is this available?" photo → matched to the catalog
> 🎬 SAM 3.1 + Muse Image turn a counter photo into a Reel, posted to the shop's own Instagram
>
> #MetaAIHackathon @AIatMeta @cerebral_valley

Attach the rendered Reel and a 20-second screen capture of a voice note getting answered.

## Evidence to capture before submitting

- Playground replies on the real catalog with `AI_PROVIDER=meta` (screenshots + timings).
- One Reel rendered with SAM 3.1 + Muse Image (before/after frame).
- One real comment → reply and one DM → reply on @pdaftar.uz from the tester account.
