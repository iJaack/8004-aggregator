import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

export function ipfsToGatewayUrl(uri: string, gatewayBase: string): string {
  // Accept:
  // - ipfs://<cid>/<path>
  // - https://... (pass-through)
  if (uri.startsWith("ipfs://")) {
    const trimmed = uri.slice("ipfs://".length);
    const [cid, ...rest] = trimmed.split("/");
    const pathPart = rest.length ? `/${rest.join("/")}` : "";
    const base = gatewayBase.endsWith("/") ? gatewayBase.slice(0, -1) : gatewayBase;
    return `${base}/ipfs/${cid}${pathPart}`;
  }
  return uri;
}

export async function fetchJsonWithKeccak(
  url: string
): Promise<{ json: unknown; bytes: Uint8Array; keccakHex: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const digest = keccak_256(buf);
  const keccakHex = `0x${bytesToHex(digest)}`;
  const text = new TextDecoder().decode(buf);
  const json = JSON.parse(text) as unknown;
  return { json, bytes: buf, keccakHex };
}

