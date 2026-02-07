import Fastify from "fastify";
import cors from "@fastify/cors";
import { envInt, envOrDefault, makePgPool, normalizeEconomicValue, normalizeValue, timeDecayWeight, trustScoreToWeight } from "@8004/shared";

type SortBy =
  | "compositeScore"
  | "uptimeScore"
  | "qualityScore"
  | "feedbackCount";

type LeaderboardCategory = "overall" | "uptime" | "quality" | "economic" | "trending";

const API_PORT = envInt("API_PORT", 3000);
const TRUST_MIN_SCORE = envInt("TRUST_MIN_SCORE", 60);
const IDENTITY_REGISTRY_ADDRESS = envOrDefault("IDENTITY_REGISTRY_ADDRESS", "").toLowerCase();

const pool = makePgPool();

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

fastify.get("/health", async () => ({ ok: true }));

// Used to normalize "revenues" feedback consistently with score-calculator.
const cachedMaxRevenueByChain = new Map<number, { value: number | undefined; fetchedAtMs: number }>();

async function maxRevenueCached(chainId: number): Promise<number | undefined> {
  const nowMs = Date.now();
  const cached = cachedMaxRevenueByChain.get(chainId);
  if (cached && nowMs - cached.fetchedAtMs < 60_000) return cached.value;

  const res = await pool.query(
    `
      SELECT
        MAX((value / power(10::numeric, value_decimals))::numeric)::text AS max_rev
      FROM feedback
      WHERE tag1 = 'revenues' AND is_revoked = FALSE AND chain_id = $1
    `,
    [chainId]
  );

  const raw = res.rows[0]?.max_rev as string | null | undefined;
  const n = raw ? Number(raw) : Number.NaN;

  const value = Number.isFinite(n) ? n : undefined;
  cachedMaxRevenueByChain.set(chainId, { value, fetchedAtMs: nowMs });
  return value;
}

function canonicalAgentId(agentId: string): string {
  const raw = agentId.trim();
  if (!raw) return raw;

  // Canonical: "eip155:<chainId>:<identityRegistry>:<tokenId>"
  if (raw.toLowerCase().startsWith("eip155:")) return raw.toLowerCase();

  // Back-compat: "chainId:tokenId" -> use configured Identity Registry (Fuji MVP).
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (m && IDENTITY_REGISTRY_ADDRESS) {
    const chainId = Number.parseInt(m[1]!, 10);
    const tokenId = m[2]!;
    return `eip155:${chainId}:${IDENTITY_REGISTRY_ADDRESS}:${tokenId}`;
  }

  return raw;
}

function chainIdFromAgentId(agentId: string): number | undefined {
  const raw = agentId.trim().toLowerCase();
  if (!raw) return undefined;
  const parts = raw.split(":");

  if (parts[0] === "eip155" && parts.length >= 4) {
    const chainId = Number.parseInt(parts[1] ?? "", 10);
    return Number.isFinite(chainId) ? chainId : undefined;
  }

  // Legacy "chainId:tokenId"
  if (parts.length >= 2) {
    const chainId = Number.parseInt(parts[0] ?? "", 10);
    return Number.isFinite(chainId) ? chainId : undefined;
  }

  return undefined;
}

fastify.get<{
  Params: { agentId: string };
}>("/v1/agents/:agentId/score", async (req, reply) => {
  const agentId = canonicalAgentId(req.params.agentId);

  const row = await pool.query(
    `
      SELECT
        agent_id,
        chain_id,
        uptime_score,
        quality_score,
        economic_score,
        composite_score,
        trend_7d,
        trend_30d,
        feedback_count,
        reviewer_count,
        confidence_level,
        calculated_at,
        oldest_feedback,
        newest_feedback
      FROM agent_scores
      WHERE agent_id = $1
      LIMIT 1
    `,
    [agentId]
  );

  if (!row.rows.length) {
    return reply.code(404).send({ error: "Agent not found" });
  }

  const r = row.rows[0] as Record<string, unknown>;
  return {
    agentId: String(r.agent_id),
    chainId: Number(r.chain_id),
    compositeScore: Number(r.composite_score),
    uptimeScore: Number(r.uptime_score),
    qualityScore: Number(r.quality_score),
    economicScore: Number(r.economic_score),
    trend7d: Number(r.trend_7d ?? 0),
    trend30d: Number(r.trend_30d ?? 0),
    feedbackCount: Number(r.feedback_count ?? 0),
    reviewerCount: Number(r.reviewer_count ?? 0),
    confidenceLevel: String(r.confidence_level ?? "low"),
    calculatedAt: new Date(String(r.calculated_at)).toISOString(),
    oldestFeedback: r.oldest_feedback ? new Date(String(r.oldest_feedback)).toISOString() : null,
    newestFeedback: r.newest_feedback ? new Date(String(r.newest_feedback)).toISOString() : null
  };
});

fastify.get<{
  Params: { agentId: string };
  Querystring: { tag1?: string; trustedOnly?: string; limit?: string; offset?: string };
}>("/v1/agents/:agentId/feedback", async (req) => {
  const agentId = canonicalAgentId(req.params.agentId);
  const tag1 = req.query.tag1;
  const trustedOnly = (req.query.trustedOnly ?? "true").toLowerCase() === "true";
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? "50", 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset ?? "0", 10) || 0);

  const where: string[] = [
    "f.agent_id = $1",
    "f.is_revoked = FALSE",
    "COALESCE(f.is_sybil_flagged, FALSE) = FALSE",
  ];
  const params: Array<string | number | boolean> = [agentId];
  let p = 2;

  if (tag1) {
    where.push(`f.tag1 = $${p++}`);
    params.push(tag1);
  }

  if (trustedOnly) {
    where.push(`COALESCE(r.trust_score, 50) >= $${p++}`);
    params.push(TRUST_MIN_SCORE);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await pool.query(
    `
      SELECT COUNT(*)::bigint AS total
      FROM feedback f
      LEFT JOIN reviewers r ON lower(r.address) = lower(f.client_address)
      ${whereSql}
    `,
    params
  );
  const total = Number(totalRes.rows[0]?.total ?? 0);

  const rowsRes = await pool.query(
    `
      SELECT
        f.transaction_hash,
        f.client_address,
        f.value::text AS value_raw,
        f.value_decimals,
        f.tag1,
        f.tag2,
        f.endpoint,
        EXTRACT(EPOCH FROM f.block_timestamp)::bigint AS block_ts,
        COALESCE(r.trust_score, 50) AS reviewer_trust_score
      FROM feedback f
      LEFT JOIN reviewers r ON lower(r.address) = lower(f.client_address)
      ${whereSql}
      ORDER BY f.block_timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    params
  );

  const nowMs = Date.now();
  const parsedChainId = chainIdFromAgentId(agentId);
  const maxRev = parsedChainId !== undefined ? await maxRevenueCached(parsedChainId) : undefined;

  const feedback = rowsRes.rows.map((r) => {
    const tag = (r.tag1 ?? "") as string;
    const valueRaw = String(r.value_raw);
    const decimals = Number(r.value_decimals ?? 0);
    const trustScore = Number(r.reviewer_trust_score ?? 50);
    const trustWeight = trustScoreToWeight(trustScore);
    const blockTs = Number(r.block_ts ?? 0);
    const timeDecay = timeDecayWeight(blockTs, nowMs);
    const weight = trustWeight * timeDecay;

    const normalizedValue =
      tag === "revenues" || tag === "tradingYield" || tag === "paymentSuccess"
        ? normalizeEconomicValue(tag, valueRaw, decimals, maxRev)
        : normalizeValue(valueRaw, decimals, tag);

    return {
      transactionHash: String(r.transaction_hash),
      clientAddress: String(r.client_address),
      value: Number(valueRaw) / Math.pow(10, decimals),
      normalizedValue,
      tag1: r.tag1 ?? null,
      tag2: r.tag2 ?? null,
      endpoint: r.endpoint ?? null,
      timestamp: new Date(blockTs * 1000).toISOString(),
      reviewerTrustScore: trustScore,
      weight
    };
  });

  return {
    feedback,
    total,
    hasMore: offset + feedback.length < total
  };
});

fastify.get<{
  Params: { agentId: string };
  Querystring: { interval?: string; from?: string; to?: string; limit?: string };
}>("/v1/agents/:agentId/history", async (req, reply) => {
  const agentId = canonicalAgentId(req.params.agentId);

  const intervalRaw = (req.query.interval ?? "daily").toLowerCase();
  const interval = intervalRaw === "hourly" || intervalRaw === "daily" || intervalRaw === "weekly" ? intervalRaw : null;
  if (!interval) return reply.code(400).send({ error: "Invalid interval (expected hourly|daily|weekly)" });

  const limit = Math.min(5000, Math.max(1, Number.parseInt(req.query.limit ?? "500", 10) || 500));

  const where: string[] = ["agent_id = $1", "interval_type = $2"];
  const params: Array<string | Date> = [agentId, interval];
  let p = 3;

  if (req.query.from) {
    const d = new Date(req.query.from);
    if (!Number.isFinite(d.getTime())) return reply.code(400).send({ error: "Invalid from (expected RFC3339 date-time)" });
    where.push(`interval_start >= $${p++}`);
    params.push(d);
  }

  if (req.query.to) {
    const d = new Date(req.query.to);
    if (!Number.isFinite(d.getTime())) return reply.code(400).send({ error: "Invalid to (expected RFC3339 date-time)" });
    where.push(`interval_start <= $${p++}`);
    params.push(d);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const rowsRes = await pool.query(
    `
      SELECT
        interval_start,
        uptime_score,
        quality_score,
        economic_score,
        composite_score,
        feedback_count
      FROM agent_scores_history
      ${whereSql}
      ORDER BY interval_start ASC
      LIMIT ${limit}
    `,
    params
  );

  return rowsRes.rows.map((r) => ({
    timestamp: new Date(String(r.interval_start)).toISOString(),
    compositeScore: Number(r.composite_score ?? 0),
    uptimeScore: Number(r.uptime_score ?? 0),
    qualityScore: Number(r.quality_score ?? 0),
    economicScore: Number(r.economic_score ?? 0),
    feedbackCount: Number(r.feedback_count ?? 0),
  }));
});

fastify.get<{
  Querystring: { chainId?: string; category?: LeaderboardCategory; limit?: string };
}>("/v1/leaderboard", async (req) => {
  const chainId = req.query.chainId ? Number.parseInt(req.query.chainId, 10) : undefined;
  const category = (req.query.category ?? "overall") as LeaderboardCategory;
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "10", 10) || 10));

  const scoreCol = (() => {
    switch (category) {
      case "uptime":
        return "uptime_score";
      case "quality":
        return "quality_score";
      case "economic":
        return "economic_score";
      case "trending":
        // MVP: trending by 7d delta
        return "trend_7d";
      case "overall":
      default:
        return "composite_score";
    }
  })();

  const where: string[] = [];
  const params: Array<number> = [];
  if (chainId !== undefined && Number.isFinite(chainId)) {
    where.push(`chain_id = $1`);
    params.push(chainId);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await pool.query(
    `
      SELECT agent_id, ${scoreCol}::text AS score
      FROM agent_scores
      ${whereSql}
      ORDER BY ${scoreCol} DESC NULLS LAST
      LIMIT ${limit}
    `,
    params
  );

  return rows.rows.map((r, idx) => ({
    rank: idx + 1,
    agentId: String(r.agent_id),
    name: null,
    score: Number(r.score ?? 0),
    change: 0
  }));
});

fastify.get<{
  Querystring: {
    minCompositeScore?: string;
    minUptimeScore?: string;
    minConfidence?: string;
    chainId?: string;
    sortBy?: SortBy;
    order?: "asc" | "desc";
    limit?: string;
  };
}>("/v1/search", async (req) => {
  const minCompositeScore = req.query.minCompositeScore ? Number(req.query.minCompositeScore) : undefined;
  const minUptimeScore = req.query.minUptimeScore ? Number(req.query.minUptimeScore) : undefined;
  const minConfidence = req.query.minConfidence as "low" | "medium" | "high" | undefined;
  const chainId = req.query.chainId ? Number.parseInt(req.query.chainId, 10) : undefined;
  const sortBy = (req.query.sortBy ?? "compositeScore") as SortBy;
  const order = (req.query.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? "20", 10) || 20));

  const sortCol = (() => {
    switch (sortBy) {
      case "uptimeScore":
        return "uptime_score";
      case "qualityScore":
        return "quality_score";
      case "feedbackCount":
        return "feedback_count";
      case "compositeScore":
      default:
        return "composite_score";
    }
  })();

  const where: string[] = [];
  const params: Array<number | string> = [];
  let p = 1;

  if (minCompositeScore !== undefined && Number.isFinite(minCompositeScore)) {
    where.push(`composite_score >= $${p++}`);
    params.push(minCompositeScore);
  }
  if (minUptimeScore !== undefined && Number.isFinite(minUptimeScore)) {
    where.push(`uptime_score >= $${p++}`);
    params.push(minUptimeScore);
  }
  if (minConfidence) {
    where.push(`confidence_level = $${p++}`);
    params.push(minConfidence);
  }
  if (chainId !== undefined && Number.isFinite(chainId)) {
    where.push(`chain_id = $${p++}`);
    params.push(chainId);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRes = await pool.query(`SELECT COUNT(*)::bigint AS total FROM agent_scores ${whereSql}`, params);
  const total = Number(totalRes.rows[0]?.total ?? 0);

  const rowsRes = await pool.query(
    `
      SELECT
        agent_id,
        chain_id,
        composite_score,
        uptime_score,
        quality_score,
        economic_score,
        trend_7d,
        trend_30d,
        feedback_count,
        reviewer_count,
        confidence_level,
        calculated_at
      FROM agent_scores
      ${whereSql}
      ORDER BY ${sortCol} ${order} NULLS LAST
      LIMIT ${limit}
    `,
    params
  );

  const agents = rowsRes.rows.map((r) => ({
    agentId: String(r.agent_id),
    chainId: Number(r.chain_id),
    compositeScore: Number(r.composite_score),
    uptimeScore: Number(r.uptime_score),
    qualityScore: Number(r.quality_score),
    economicScore: Number(r.economic_score),
    trend7d: Number(r.trend_7d ?? 0),
    trend30d: Number(r.trend_30d ?? 0),
    feedbackCount: Number(r.feedback_count ?? 0),
    reviewerCount: Number(r.reviewer_count ?? 0),
    confidenceLevel: String(r.confidence_level ?? "low"),
    calculatedAt: new Date(String(r.calculated_at)).toISOString()
  }));

  return { agents, total };
});

fastify.get<{
  Params: { address: string };
}>("/v1/reviewers/:address", async (req, reply) => {
  const address = req.params.address.toLowerCase();

  const row = await pool.query(
    `
      SELECT
        address,
        trust_score,
        trust_tier,
        total_feedback_given,
        unique_agents_reviewed,
        revocation_rate,
        is_verified_watchtower,
        first_feedback_at,
        last_feedback_at
      FROM reviewers
      WHERE lower(address) = $1
      LIMIT 1
    `,
    [address]
  );

  if (!row.rows.length) {
    return reply.code(404).send({ error: "Reviewer not found" });
  }

  const r = row.rows[0] as Record<string, unknown>;
  return {
    address: String(r.address),
    trustScore: Number(r.trust_score ?? 50),
    trustTier: String(r.trust_tier ?? "unknown"),
    totalFeedbackGiven: Number(r.total_feedback_given ?? 0),
    uniqueAgentsReviewed: Number(r.unique_agents_reviewed ?? 0),
    revocationRate: Number(r.revocation_rate ?? 0),
    isVerifiedWatchtower: Boolean(r.is_verified_watchtower ?? false),
    firstFeedbackAt: r.first_feedback_at ? new Date(String(r.first_feedback_at)).toISOString() : null,
    lastFeedbackAt: r.last_feedback_at ? new Date(String(r.last_feedback_at)).toISOString() : null
  };
});

fastify.get<{
  Params: { address: string };
  Querystring: { limit?: string; offset?: string };
}>("/v1/reviewers/:address/feedback", async (req) => {
  const address = req.params.address.toLowerCase();
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? "50", 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset ?? "0", 10) || 0);

  const totalRes = await pool.query(
    `
      SELECT COUNT(*)::bigint AS total
      FROM feedback
      WHERE lower(client_address) = $1
    `,
    [address]
  );
  const total = Number(totalRes.rows[0]?.total ?? 0);

  const rowsRes = await pool.query(
    `
      SELECT
        chain_id,
        agent_id,
        transaction_hash,
        value::text AS value_raw,
        value_decimals,
        tag1,
        tag2,
        endpoint,
        is_revoked,
        EXTRACT(EPOCH FROM block_timestamp)::bigint AS block_ts
      FROM feedback
      WHERE lower(client_address) = $1
      ORDER BY block_timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    [address]
  );

  const chainIds = new Set<number>();
  for (const r of rowsRes.rows as Array<Record<string, unknown>>) {
    const cid = Number(r.chain_id ?? Number.NaN);
    if (Number.isFinite(cid)) chainIds.add(cid);
  }

  const maxRevByChain = new Map<number, number | undefined>();
  for (const cid of chainIds) {
    maxRevByChain.set(cid, await maxRevenueCached(cid));
  }

  const feedback = rowsRes.rows.map((r) => {
    const tag = (r.tag1 ?? "") as string;
    const valueRaw = String(r.value_raw);
    const decimals = Number(r.value_decimals ?? 0);
    const chainId = Number(r.chain_id ?? 0);
    const maxRev = maxRevByChain.get(chainId);

    const normalizedValue =
      tag === "revenues" || tag === "tradingYield" || tag === "paymentSuccess"
        ? normalizeEconomicValue(tag, valueRaw, decimals, maxRev)
        : normalizeValue(valueRaw, decimals, tag);

    return {
      agentId: String(r.agent_id),
      chainId,
      transactionHash: String(r.transaction_hash),
      value: Number(valueRaw) / Math.pow(10, decimals),
      normalizedValue,
      tag1: r.tag1 ?? null,
      tag2: r.tag2 ?? null,
      endpoint: r.endpoint ?? null,
      isRevoked: Boolean(r.is_revoked ?? false),
      timestamp: new Date(Number(r.block_ts ?? 0) * 1000).toISOString(),
    };
  });

  return {
    feedback,
    total,
    hasMore: offset + feedback.length < total,
  };
});

fastify.addHook("onClose", async () => {
  await pool.end();
});

await fastify.listen({ port: API_PORT, host: envOrDefault("API_HOST", "0.0.0.0") });
