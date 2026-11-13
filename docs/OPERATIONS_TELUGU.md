# PDS Government Updates – నిర్వహణ గైడ్ (సరళమైన తెలుగులో)

## సిస్టమ్ ఎలా పనిచేస్తుంది
1. cron-job.org ప్రతి 15 నిమిషాలకు `/api/monitor` ను పిలుస్తుంది.
2. ప్రతి రన్‌లో 20 ప్రభుత్వ సైట్లు తనిఖీ అవుతాయి (86 సైట్లు, సుమారు 75 నిమిషాలకు ఒక చక్రం).
3. కొత్త లింక్ దొరికితే → AI వివరాలు తీస్తుంది → అధికారిక సైట్‌తో సరిచూస్తుంది → మీ Telegram కు వస్తుంది.
4. మీరు **ACCEPT / REJECT / VERIFY** నొక్కుతారు. ACCEPT చేస్తే పోస్టర్ + క్యాప్షన్ వస్తుంది.
5. పోస్టర్‌ను WhatsApp గ్రూప్‌కు పంపడానికి: పోస్టర్‌ను నొక్కి పట్టి → Forward/Share → WhatsApp → గ్రూప్ (లేదా "Share Poster" బటన్).

## రోజువారీ
- ఉదయం 8 తర్వాత Telegram లో **"🟢 PDS రోజువారీ నివేదిక"** వస్తుంది. **ఒకరోజు రాకపోతే** సిస్టమ్ ఆగిపోయింది: దిగువ "సమస్యలు" చూడండి.
- వేచి ఉన్న అలర్ట్‌లకు ACCEPT / REJECT నొక్కండి. REJECT చేసినవి మళ్ళీ రావు.

## హెల్త్ పేజీ
`https://pds-gov-updates.vercel.app/api/health?key=<CRON_SECRET>`
- ✅ OK / ⚠️ WARNING / ❌ DOWN, తెరుచుకోని సైట్లు, విఫల పంపకాలు చూపిస్తుంది.
- `&ai=1` చేరిస్తే AI కనెక్షన్ పరీక్ష అవుతుంది.

## సమస్యలు – ఏం చేయాలి
| సమస్య | పరిష్కారం |
|---|---|
| రోజువారీ నివేదిక రాలేదు | cron-job.org లో job "Enabled" ఉందా, చివరి రన్ "200 OK" నా చూడండి. హెల్త్ పేజీ తెరవండి. |
| అలర్ట్‌లు రావడం లేదు | హెల్త్ లో `alerts` / `telegram` చూడండి. `/api/telegram-setup?key=<CRON_SECRET>&test=1` తెరిస్తే టెస్ట్ మెసేజ్ వస్తుంది. |
| AI ❌ | `&ai=1` ఫలితం చూడండి. Gemini కీ చెల్లుతుందా, aistudio.google.com లో పరిమితి అయిపోయిందా చూడండి. |
| ఒక సైట్ తెరుచుకోదు | హెల్త్ లో కారణం కనిపిస్తుంది. నిరంతరం విఫలమైతే `config/sources.json` లో ఆ సైట్‌కు `"active": false` పెట్టండి. |

## సైట్లు చేర్చడం / తీసివేయడం
GitHub లో `config/sources.json` తెరిచి ✏️ (Edit) నొక్కండి. కొత్త సైట్:
```
{ "id": "c-ఉదాహరణ", "government": "Central", "department": "...", "name": "...", "url": "https://...", "priority": 2 }
```
`priority`: 1 = ఎక్కువసార్లు తనిఖీ. తీసివేయడానికి `"active": false` చేర్చండి. Commit చేస్తే ఆటోమేటిక్‌గా అమలవుతుంది.

## ఏ అలర్ట్‌లు వస్తాయి (మార్చుకోవచ్చు)
ఉద్యోగాలు, దరఖాస్తు, గడువు పొడిగింపు, పరీక్షలు, హాల్ టికెట్లు, ఫలితాలు, పథకాలు, పౌర సేవలు. GO లు, సర్క్యులర్లు రావు.
మార్చడానికి Vercel లో `ALERT_CATEGORIES` (కామాతో వేరు చేసి) పెట్టండి. ఉదా: `recruitment,exam,hall_ticket,result`.
పేర్లు: recruitment, application, deadline_extension, exam, hall_ticket, result, scheme, citizen_service, announcement, government_order, circular, other.

## ఖర్చులు (ఇప్పుడు అన్నీ ఉచితం)
Vercel Hobby, Supabase ఉచిత ప్లాన్ (500 MB; పాత పోస్టర్లు 60 రోజుల తర్వాత ఆటోమేటిక్‌గా తొలగిపోతాయి), Gemini ఉచిత టియర్, Telegram, cron-job.org.
Gemini ఉచిత పరిమితులు మారవచ్చు. అవి అయిపోతే AI ఆగుతుంది (అలర్ట్‌లు వేచి ఉండి, తర్వాత వస్తాయి).

## బ్యాకప్
నెలకోసారి `https://pds-gov-updates.vercel.app/api/export?key=<CRON_SECRET>` తెరిచి వచ్చే ఫైల్‌ను భద్రపరచండి.

## కీలు మార్చడం (భద్రత కోసం, అప్పుడప్పుడు)
- **Gemini కీ:** aistudio.google.com/apikey లో కొత్త కీ → Vercel లో `GEMINI_API_KEY` మార్చండి → Redeploy.
- **Telegram టోకెన్:** BotFather → `/revoke` → కొత్త టోకెన్ → Vercel లో `TELEGRAM_BOT_TOKEN` → Redeploy → `/api/telegram-setup?key=...` తెరవండి.
- **CRON_SECRET:** Vercel లో మార్చి Redeploy చేశాక, cron-job.org లో URL లోని `key=` మార్చండి.
