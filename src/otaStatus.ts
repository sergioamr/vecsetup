// OTA status codes reported by Vector's updater. Only codes we could verify are
// listed (DDL support "Vector Error & Status Codes"); others print as-is.
const known: Record<number, string> = {
  203: 'could not open URL. In practice this is often weak Wi-Fi rather than a bad link: move Vector nearer the router, keep Bluetooth disconnected, and check the URL from another machine',
  204: 'the URL did not point to a TAR (.ota) file',
  205: 'decompressor error; the .ota may be corrupt. Reboot Vector and try again',
};

export function otaStatusText(status: number): string {
  if (!Number.isFinite(status)) return 'update failed (no status code)';
  return `update failed, status ${status}: ${known[status] ?? 'unknown code'}`;
}
