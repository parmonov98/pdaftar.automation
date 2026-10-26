# Meta Global AI Developer Hackathon: submission pack

Track: **Startup**. Theme: **Build for Your World**. Deadline: **Nov 4, 2026, 9:00 PM ET** (Nov 5, 07:00 Tashkent). Plan to submit on Nov 4, Tashkent daytime.

## Owner checklist (needs your accounts)

- [ ] Claim the $150 Meta Model API credits (form in the Oct 26 Cerebral Valley email). Add a card and set the spend limit to $150.
- [ ] Create a Model API key. Put it in `~/.config/pdaftar-automation/env` on the VPS as `META_API_KEY=…`, set `AI_PROVIDER=meta`, then run `systemctl --user restart pdaftar-automation`.
- [ ] Check every model with one command: `cd ~/pdaftar/pdaftar.automation/api && node --env-file=$HOME/.config/pdaftar-automation/env dist/meta-check.js`. It tests chat, vision, SAM 3.1 and Muse Image and never prints the key.
- [ ] Create a Meta developer app with **Instagram API with Instagram Login**:
  - Redirect URI: `https://automation.pdaftar.uz/auth/instagram/callback`.
  - Webhook URL: `https://automation.pdaftar.uz/webhooks/instagram`. The verify token is `IG_WEBHOOK_VERIFY_TOKEN` in the env file. Fields: `comments`, `messages`.
  - Add @pdaftar.uz and the pdaftar_uz test account as app roles (Instagram testers).
  - Put `IG_APP_ID` and `IG_APP_SECRET` in the env file and restart.
- [ ] Read the official rules on the participant page. Confirm: pre-event code, a public repo or not, demo video length, licence.
- [ ] Decide whether the GitHub repo is public (if the rules require it). The repo is not pushed yet; creating it was left for you.

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

## Evidence to capture before submitting

- Playground replies on the real catalog with `AI_PROVIDER=meta` (screenshots + timings).
- One Reel rendered with SAM 3.1 + Muse Image (before/after frame).
- One real comment → reply and one DM → reply on @pdaftar.uz from the tester account.
