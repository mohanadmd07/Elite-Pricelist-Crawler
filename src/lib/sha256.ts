/**
 * Cross-environment SHA-256 helper.
 * Uses the WebCrypto API available natively in browsers and Node >= 18,
 * so callers never import the Node `crypto` module into client bundles.
 */

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback: Node's crypto via dynamic import (never bundled into browser chunks
  // because this branch only executes when WebCrypto is absent, i.e. in Node).
  const nodeCrypto = await import(/* @vite-ignore */ 'crypto');
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}
