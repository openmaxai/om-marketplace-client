// Limits of the IM send, in UTF-8 bytes; a message over them is refused by the IM service, never truncated.
export const MAX_BODY_BYTES = 16384;
export const MAX_FALLBACK_BYTES = 8192;
// Appended to text cut to fit a size limit: the first guide cut to fit MAX_BODY_BYTES, or a cut fallback text.
export const TRUNCATION_SUFFIX = '…（完整内容见 Agent 详情）';
// Message metadata keys the IM service reserves (agent_run is dropped, cap_notice is refused) and context, which the
// openmax CLI refuses in metadata from 2.33.0 on; the client refuses all of them itself, as older CLIs do not check.
export const RESERVED_METADATA_KEYS = Object.freeze(['agent_run', 'cap_notice', 'context']);

export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

// True when the body text and the fallback text (when there is one) are within the byte limits.
export function withinLimits({ text, fallbackText }, { maxBodyBytes = MAX_BODY_BYTES, maxFallbackBytes = MAX_FALLBACK_BYTES } = {}) {
  return utf8Bytes(text) <= maxBodyBytes && (fallbackText == null || utf8Bytes(fallbackText) <= maxFallbackBytes);
}
