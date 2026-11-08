# PDS Government Updates Automation

Monitoring → AI extraction → official-source verification → private WhatsApp alert → ACCEPT / REJECT / VERIFY → PDS poster + caption → Save / Share.

- `api/monitor.ts` scheduler entry (batch of sources per call) · `api/webhook.ts` Gupshup callback · `api/n.ts` private detail page
- `api/health.ts` health · `api/export.ts` backup · `api/poster.ts` signed poster download · `api/action.ts` web buttons
- `lib/` pipeline, fetcher, AI extraction, verification, poster (SVG→PNG, Telugu shaping), WhatsApp (Gupshup)
- `config/sources.json` monitored official websites · `db/schema.sql` PostgreSQL schema
- Tests: `npm test` (unit) and `npx tsx --test tests/e2e.test.ts` (needs a local Postgres)
- Setup guide in Telugu: `docs/SETUP_TELUGU.md`, WhatsApp template: `docs/WHATSAPP_TEMPLATE.md`
