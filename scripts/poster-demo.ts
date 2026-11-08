import { mkdirSync, writeFileSync } from 'node:fs';
import { renderPoster } from '../lib/poster.js';
import { NOT_MENTIONED } from '../lib/config.js';

const f: any = Object.fromEntries(
  ['title','department','post_names','vacancies','eligibility','age_limit','qualification','required_documents','application_start','last_date','exam_date','application_fee','category_fee','selection_process','revised_dates','deadline_extension','important_instructions','application_process','application_url','notification_url'].map((k) => [k, NOT_MENTIONED]),
);
Object.assign(f, {
  title: 'Recruitment of Junior Assistants and Staff Nurses 2026',
  department: 'Telangana Medical & Health Services Recruitment Board',
  post_names: 'Junior Assistant; Staff Nurse; Lab Technician',
  vacancies: '1,284',
  qualification: 'Intermediate / B.Sc Nursing / DMLT as per post',
  eligibility: 'Indian citizen; local candidates of Telangana as per rules',
  age_limit: '18 to 44 years (relaxation as per rules)',
  application_start: '10 Nov 2026',
  last_date: '30 Nov 2026',
  exam_date: 'Dec 2026 (to be announced)',
  application_fee: 'Rs. 500 (SC/ST/PH: Rs. 250)',
  selection_process: 'Written exam followed by certificate verification',
  important_instructions: 'Apply online only. Keep scanned photo, signature and certificates ready. Visit www.example.gov.in for details.',
});
mkdirSync('out', { recursive: true });
writeFileSync('out/poster-demo.png', await renderPoster({ headline_te: 'తెలంగాణ వైద్య ఆరోగ్య శాఖలో 1,284 పోస్టుల భర్తీ నోటిఫికేషన్', fields: f }));
console.log('written out/poster-demo.png');
