import type { ConfidenceLevel } from "./types.js";

export function trustScoreToWeight(trustScore: number): number {
  // 0-100 trust → 0.5-2.0 weight
  const clamped = Math.max(0, Math.min(100, trustScore));
  return 0.5 + (clamped / 100) * 1.5;
}

export function timeDecayWeight(blockTimestampSec: number, nowMs: number): number {
  const ageMs = nowMs - blockTimestampSec * 1000;
  const daysOld = ageMs / (1000 * 60 * 60 * 24);
  // Half-life of 30 days
  const halfLife = 30;
  return Math.pow(0.5, daysOld / halfLife);
}

export function determineConfidence(
  feedbackCount: number,
  reviewerCount: number
): ConfidenceLevel {
  if (feedbackCount >= 50 && reviewerCount >= 10) return "high";
  if (feedbackCount >= 10 && reviewerCount >= 3) return "medium";
  return "low";
}

export function normalizeValue(valueRaw: string, decimals: number, tag1: string): number {
  // valueRaw is numeric string (can be negative)
  const numValue = Number(valueRaw) / Math.pow(10, decimals);

  switch (tag1) {
    case "uptime":
      return clamp01to100(numValue);
    case "reachable":
      return numValue > 0 ? 100 : 0;
    case "starred":
      return clamp01to100(numValue);
    case "responseTime":
      // Lower is better: 0ms = 100, 5000ms = 0 (matches architecture draft)
      return Math.max(0, 100 - numValue / 50);
    case "successRate":
      return clamp01to100(numValue);
    default:
      return clamp01to100(numValue);
  }
}

export function normalizeEconomicValue(tag1: string, valueRaw: string, decimals: number, maxRevenue?: number): number {
  const numValue = Number(valueRaw) / Math.pow(10, decimals);

  switch (tag1) {
    case "paymentSuccess":
      return clamp01to100(numValue);
    case "tradingYield": {
      // -100%..+100% -> 0..100
      const clamped = Math.max(-100, Math.min(100, numValue));
      return (clamped + 100) / 2;
    }
    case "revenues": {
      if (!maxRevenue || maxRevenue <= 0) return 50;
      const pct = (Math.max(0, numValue) / maxRevenue) * 100;
      return clamp01to100(pct);
    }
    default:
      return clamp01to100(numValue);
  }
}

function clamp01to100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

