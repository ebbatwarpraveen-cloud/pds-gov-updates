export const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
export const envInt = (k: string, d: number): number => {
  const n = parseInt(env(k), 10);
  return Number.isFinite(n) ? n : d;
};

export const BRAND = {
  name: 'PDS | PRAVEEN DIGITAL SERVICES',
  short: 'PDS',
  full: 'PRAVEEN DIGITAL SERVICES',
  tagline: 'Your Work • Our Support • Easy & Fast',
  phones: ['6305478376', '9948485930'],
};

export const NOT_MENTIONED = 'Not mentioned in the official notification';

export const cfg = {
  baseUrl: () => env('PUBLIC_BASE_URL').replace(/\/$/, ''),
  owner: () => env('OWNER_WHATSAPP').replace(/\D/g, ''),
  sourcesPerRun: () => envInt('SOURCES_PER_RUN', 20),
  maxCandidates: () => envInt('MAX_CANDIDATES_PER_RUN', 12),
  healthMaxAgeMin: () => envInt('HEALTH_MAX_AGE_MIN', 1560),
  model: () => env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
  groupSendEnabled: () => env('GROUP_SEND_ENABLED') === 'true',
};
