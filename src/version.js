import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const CLIENT_VERSION = pkg.version;

// Must match the header name the market server reads for the client version gate.
export const CLIENT_VERSION_HEADER = 'X-Market-Client-Version';

export function buildHeaders(config, extra = {}) {
  if (!config?.api_key) throw new Error('api_key is not configured');
  return {
    ...extra,
    Authorization: `Bearer ${config.api_key}`,
    [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
  };
}
