import dotenv from "dotenv";

let didLoad = false;

export function loadEnvOnce(): void {
  if (didLoad) return;
  dotenv.config();
  didLoad = true;
}

export function envOrDefault(name: string, fallback: string): string {
  loadEnvOnce();
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function mustEnv(name: string): string {
  loadEnvOnce();
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`Missing env var: ${name}`);
  return v;
}

export function envInt(name: string, fallback: number): number {
  const raw = envOrDefault(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

