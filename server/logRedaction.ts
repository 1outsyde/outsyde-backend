/** Keeps signed ticket QR tokens out of the request log. */
export function redactLogPath(path: string): string {
  return path.replace(/^(\/api\/events\/qr\/)[^/]*\.png$/, "$1[token].png");
}
