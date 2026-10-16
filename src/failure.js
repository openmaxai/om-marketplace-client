// C-06 error codes a client may report.
export const RESULT_CODES = new Set([
  'PACKAGE_MISMATCH', 'PACKAGE_UNSAFE', 'INSTALL_TARGET_CONFLICT', 'VERSION_REVOKED', 'CLIENT_INTERNAL', 'SHELF_RESPONSE_INVALID',
]);

// A failed install with its C-06 code. The message is a fixed token: never package paths or stack traces.
export class InstallFailure extends Error {
  constructor(code, message) {
    if (!RESULT_CODES.has(code)) throw new TypeError(`unknown result code ${code}`);
    super(`${code}: ${message}`);
    this.name = 'InstallFailure';
    this.code = code;
    this.reason = message;
  }
}
