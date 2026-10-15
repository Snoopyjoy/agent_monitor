import { fetchJson } from '../util.js';

const WEB = 'https://cursor.com';
const API2 = 'https://api2.cursor.sh';

/** Endpoints used by cursor.com/dashboard, authenticated with the IDE's own session token. */
export function cursorClient(token, userId) {
  const web = {
    Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: WEB,
    Referer: `${WEB}/dashboard`,
  };
  const bearer = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  return {
    usageSummary: () => fetchJson(`${WEB}/api/usage-summary`, { headers: web }),
    me: () => fetchJson(`${WEB}/api/auth/me`, { headers: web }),
    stripeProfile: () => fetchJson(`${API2}/auth/full_stripe_profile`, { headers: bearer }),
    usageEvents: body => fetchJson(`${WEB}/api/dashboard/get-filtered-usage-events`, {
      method: 'POST',
      headers: web,
      body: JSON.stringify(body),
      timeoutMs: 20000,
    }),
  };
}
