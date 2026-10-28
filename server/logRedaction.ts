/** Keeps signed ticket QR and Wallet pass tokens out of the request log. */
export function redactLogPath(path: string): string {
  return path
    .replace(/^(\/api\/events\/qr\/).*$/i, "$1[token].png")
    .replace(/^(\/api\/events\/wallet\/).*$/i, "$1[token].pkpass");
}
