# WhatsApp Template (Gupshup dashboard → Templates → Create)

Create ONE template. WhatsApp must approve it before the system can message you first.

- **Name:** `pds_gov_alert`
- **Category:** Utility (if rejected, choose Marketing)
- **Language:** English
- **Type:** Text, **Buttons:** Quick Reply → 3 buttons exactly: `ACCEPT`, `REJECT`, `VERIFY`

**Body (copy exactly):**

```
NEW GOVERNMENT UPDATE

Department: {{1}}
Notification: {{2}}
Posts / Vacancies: {{3}}
Key dates: {{4}}

Full verified details and official links: {{5}}

Please choose an action below.
```

**Sample values for approval:**
1. Medical & Health Services Recruitment Board
2. Recruitment of Staff Nurses 2026
3. Staff Nurse - Vacancies: 120
4. Last date 30-11-2026
5. https://your-project.vercel.app/api/n?id=1&t=abc123

After approval copy the **Template ID** into `GUPSHUP_ALERT_TEMPLATE_ID`.

## Gupshup callback (webhook)
Gupshup dashboard → Webhooks → Callback URL:
`https://YOUR-PROJECT.vercel.app/api/webhook?key=YOUR_WEBHOOK_SECRET`
Enable: Message, Message-event (sent / delivered / read / failed).

## Groups
Gupshup's Groups API is a beta, request-only feature. It only works for groups created by your own business number (invite-only), and the documented send endpoint supports text only. It cannot post into your existing WhatsApp groups. So the default flow is: poster + caption → "Share Poster" button on the private page → you pick the group on your phone.
