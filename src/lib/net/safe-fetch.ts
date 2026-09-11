import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80")
  );
}

/**
 * Resolves the hostname and rejects loopback/private/link-local targets to
 * prevent SSRF against internal services or cloud metadata endpoints.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }

  const { address } = await lookup(url.hostname);
  const isPrivate = isIPv4(address) ? isPrivateIPv4(address) : isPrivateIPv6(address);
  if (isPrivate) {
    throw new Error("URL resolves to a non-public address");
  }

  return url;
}

export async function safeFetch(rawUrl: string, init?: RequestInit) {
  const url = await assertPublicHttpUrl(rawUrl);
  return fetch(url, { ...init, redirect: "manual" });
}
