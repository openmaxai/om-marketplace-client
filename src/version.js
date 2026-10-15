import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const CLIENT_VERSION = pkg.version;

// Must match the header name the market server reads for the client version gate.
export const CLIENT_VERSION_HEADER = 'X-Market-Client-Version';

// accessToken is the short-lived token cws-core issues in exchange for the Agent's API key; the API key itself is never
// sent to the BFF.
export function buildHeaders(accessToken, extra = {}) {
  if (!accessToken) throw new Error('access token is required');
  return {
    ...extra,
    Authorization: `Bearer ${accessToken}`,
    [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
  };
}
