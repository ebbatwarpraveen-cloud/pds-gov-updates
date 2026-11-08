# PDS Government Updates – సెటప్ గైడ్ (సరళమైన తెలుగులో)

ఈ సిస్టమ్ ఏం చేస్తుంది: ప్రభుత్వ వెబ్‌సైట్లను చూస్తుంది → కొత్త నోటిఫికేషన్ దొరికితే AI తో వివరాలు తీస్తుంది → అధికారిక సైట్‌తో సరిచూస్తుంది → మీకు WhatsApp లో పంపుతుంది → మీరు ACCEPT / REJECT / VERIFY నొక్కుతారు → ACCEPT చేస్తే PDS పోస్టర్ + క్యాప్షన్ వస్తుంది.

ఒక్కో అడుగు చేయండి. రహస్య కీలు (API keys) చాట్‌లో పంపకండి — Vercel లో మాత్రమే పెట్టండి.

## అడుగు 1 — డేటాబేస్ (ఉచితం)
1. supabase.com లో కొత్త ప్రాజెక్ట్ తయారు చేయండి.
2. Project Settings → Database → **Connection string (URI)** కాపీ చేయండి. ఇదే `DATABASE_URL`.

## అడుగు 2 — Vercel లో కొత్త ప్రాజెక్ట్
1. Vercel లో **Add New → Project** (పాత ప్రాజెక్టులు వాడకండి).
2. ఈ ఫోల్డర్‌ను అప్‌లోడ్/డిప్లాయ్ చేయండి (నేను చేస్తాను – అనుమతి ఇస్తే).
3. Settings → **Environment Variables** లో `.env.example` లోని పేర్లన్నీ పెట్టండి.
   - `CRON_SECRET`, `WEBHOOK_SECRET`, `LINK_SECRET` = మీరే పొడవైన రాండమ్ అక్షరాలు.
   - `PUBLIC_BASE_URL` = మీ Vercel లింక్.
   - `OWNER_WHATSAPP` = 916305478376

## అడుగు 3 — టేబుల్స్ తయారు చేయడం (ఒక్కసారి)
Supabase → **SQL Editor** లో `db/schema.sql` ఫైల్ మొత్తం పేస్ట్ చేసి **Run** నొక్కండి.

## అడుగు 4 — AI కీ
console.anthropic.com → API Keys → కీ తయారు చేసి Vercel లో `ANTHROPIC_API_KEY` గా పెట్టండి.

## అడుగు 5 — Gupshup
1. `docs/WHATSAPP_TEMPLATE.md` ప్రకారం టెంప్లేట్ తయారు చేయండి, ఆమోదం కోసం వేచి ఉండండి.
2. Callback URL పెట్టండి (అదే ఫైల్‌లో ఉంది).
3. `GUPSHUP_API_KEY`, `GUPSHUP_APP_NAME`, `GUPSHUP_SOURCE_NUMBER`, `GUPSHUP_ALERT_TEMPLATE_ID` Vercel లో పెట్టండి.

## అడుగు 6 — 24/7 నడవడానికి షెడ్యూలర్
- Vercel Pro ప్లాన్ ఉంటే: `vercel.json` లో cron ను `*/30 * * * *` గా మార్చండి.
- ఉచితంగా: cron-job.org లో ఖాతా → కొత్త job → URL: `https://YOUR-PROJECT.vercel.app/api/monitor`, ప్రతి 30 నిమిషాలకు, Header: `Authorization: Bearer YOUR_CRON_SECRET`.

## ఆరోగ్య స్థితి (Health)
`https://YOUR-PROJECT.vercel.app/api/health?key=YOUR_CRON_SECRET` – ✅ OK / ⚠️ WARNING / ❌ DOWN చూపిస్తుంది.

## బ్యాకప్
`/api/export?key=YOUR_CRON_SECRET` – మొత్తం డేటా JSON గా డౌన్‌లోడ్. Supabase లో ఆటో బ్యాకప్‌లు కూడా ఉంటాయి.

## మొదటి రోజు ఏం జరుగుతుంది
మొదటిసారి ప్రతి వెబ్‌సైట్‌ను "గుర్తు పెట్టుకోవడం" మాత్రమే జరుగుతుంది (పాత నోటిఫికేషన్లకు అలర్ట్‌లు రావు). ఆ తర్వాత వచ్చే కొత్తవే మీకు వస్తాయి.

## పోస్టర్ నియమం
పోస్టర్‌లో, క్యాప్షన్‌లో దరఖాస్తు వెబ్‌సైట్ / లింక్ ఎప్పటికీ ఉండదు (కోడ్ లోనే తనిఖీ ఉంది). లింక్ మీ ప్రైవేట్ అలర్ట్‌లో మాత్రమే ఉంటుంది.

## లోగో
మీ PDS లోగోను `assets/logo.png` గా పెట్టండి – పోస్టర్ ఆటోమేటిక్‌గా వాడుతుంది. (ఇప్పుడు తాత్కాలిక "PDS" బ్యాడ్జ్ ఉంది.)
