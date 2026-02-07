import { determineConfidence, envInt, makePgPool, normalizeEconomicValue, normalizeValue, timeDecayWeight, trustScoreToWeight } from "@8004/shared";

const REFRESH_INTERVAL_MS = envInt("SCORE_REFRESH_INTERVAL_MS", 60_000);
const BATCH_SIZE = envInt("SCORE_BATCH_SIZE", 100);
const SYBIL_DETECT_ENABLED = envInt("SYBIL_DETECT_ENABLED", 1) !== 0;
const SYBIL_BURST_WINDOW_SEC = envInt("SYBIL_BURST_WINDOW_SEC", 3600);
const SYBIL_BURST_THRESHOLD = envInt("SYBIL_BURST_THRESHOLD", 10);

const pool = makePgPool();

function detectBurstAddresses(
  rows: Array<{ client_address: string; block_ts: number }>,
  windowSec: number,
  threshold: number
): Set<string> {
  if (threshold <= 1 || windowSec <= 0) return new Set();

  const byAddress = new Map<string, number[]>();
  for (const r of rows) {
    const addr = r.client_address.toLowerCase();
    const ts = Number(r.block_ts ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const list = byAddress.get(addr);
    if (list) list.push(ts);
    else byAddress.set(addr, [ts]);
  }

  const flagged = new Set<string>();
  for (const [addr, times] of byAddress) {
    if (times.length < threshold) continue;
    times.sort((a, b) => a - b);

    // Sliding window in O(n).
    let i = 0;
    for (let j = 0; j < times.length; j++) {
      while (times[j]! - times[i]! > windowSec) i++;
      if (j - i + 1 >= threshold) {
        flagged.add(addr);
        break;
      }
    }
  }

  return flagged;
}

function detectCoordinatedTimingAddresses(
  rows: Array<{ client_address: string; block_ts: number }>,
  windowSec: number,
  minUnique: number
): Set<string> {
  if (windowSec <= 0 || minUnique <= 1) return new Set();

  const sorted = rows
    .map((r) => ({
      addr: r.client_address.toLowerCase(),
      ts: Number(r.block_ts ?? 0),
    }))
    .filter((r) => Number.isFinite(r.ts) && r.ts > 0 && r.addr)
    .sort((a, b) => a.ts - b.ts);

  const counts = new Map<string, number>();
  let i = 0;
  const flagged = new Set<string>();

  for (let j = 0; j < sorted.length; j++) {
    const jr = sorted[j]!;
    counts.set(jr.addr, (counts.get(jr.addr) ?? 0) + 1);

    while (sorted[j]!.ts - sorted[i]!.ts > windowSec) {
      const ir = sorted[i]!;
      const next = (counts.get(ir.addr) ?? 0) - 1;
      if (next <= 0) counts.delete(ir.addr);
      else counts.set(ir.addr, next);
      i++;
    }

    if (counts.size >= minUnique) {
      for (const addr of counts.keys()) flagged.add(addr);
    }
  }

  return flagged;
}

async function maxRevenueByChain(): Promise<Map<number, number>> {
  const res = await pool.query(
    `
      SELECT
        chain_id,
        MAX((value / power(10::numeric, value_decimals))::numeric)::text AS max_rev
      FROM feedback
      WHERE tag1 = 'revenues' AND is_revoked = FALSE
      GROUP BY chain_id
    `
  );

  const out = new Map<number, number>();
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const chainId = Number(row.chain_id ?? Number.NaN);
    const raw = row.max_rev as string | null | undefined;
    const n = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(chainId) || !Number.isFinite(n)) continue;
    out.set(chainId, n);
  }
  return out;
}

async function agentsNeedingRecalc(): Promise<Array<{ agent_id: string; chain_id: number }>> {
  const res = await pool.query(
    `
      WITH last_feedback AS (
        SELECT agent_id, chain_id, MAX(updated_at) AS last_update
        FROM feedback
        GROUP BY agent_id, chain_id
      )
      SELECT lf.agent_id, lf.chain_id
      FROM last_feedback lf
      LEFT JOIN agent_scores s ON s.agent_id = lf.agent_id
      WHERE s.calculated_at IS NULL OR lf.last_update > s.calculated_at
      ORDER BY lf.last_update ASC
      LIMIT $1
    `,
    [BATCH_SIZE]
  );

  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    agent_id: String(r.agent_id),
    chain_id: Number(r.chain_id),
  }));
}

async function computeTrendDays(agentId: string, days: number): Promise<number> {
  const res = await pool.query(
    `
      SELECT composite_score::text AS composite_score
      FROM agent_scores_history
      WHERE agent_id = $1
        AND interval_type = 'daily'
        AND interval_start <= (NOW() - ($2::text || ' days')::interval)
      ORDER BY interval_start DESC
      LIMIT 1
    `,
    [agentId, String(days)]
  );
  const raw = res.rows[0]?.composite_score as string | undefined;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function upsertSybilFlag(args: {
  agentId: string;
  pattern: string;
  severity: string;
  affectedAddresses: string[];
  notes: string;
}): Promise<void> {
  // Prefer an upsert when a suitable uniqueness constraint exists, but fall back to raw inserts
  // so the service still works against a DB initialized with the earlier MVP schema.
  try {
    await pool.query(
      `
        INSERT INTO sybil_flags(agent_id, pattern, severity, affected_addresses, detected_at, notes)
        VALUES ($1,$2,$3,$4,NOW(),$5)
        ON CONFLICT (agent_id, pattern) WHERE resolved_at IS NULL
        DO UPDATE SET
          severity = EXCLUDED.severity,
          affected_addresses = EXCLUDED.affected_addresses,
          detected_at = NOW(),
          resolved_at = NULL,
          notes = EXCLUDED.notes
      `,
      [args.agentId, args.pattern, args.severity, args.affectedAddresses, args.notes]
    );
  } catch {
    await pool.query(
      `
        INSERT INTO sybil_flags(agent_id, pattern, severity, affected_addresses, detected_at, notes)
        VALUES ($1,$2,$3,$4,NOW(),$5)
      `,
      [args.agentId, args.pattern, args.severity, args.affectedAddresses, args.notes]
    );
  }
}

async function calculateAndUpsertAgentScore(agentId: string, chainId: number, maxRev?: number): Promise<void> {
  const feedbackRes = await pool.query(
    `
      SELECT
        f.id,
        f.client_address,
        f.value::text AS value_raw,
        f.value_decimals,
        f.tag1,
        f.tag2,
        EXTRACT(EPOCH FROM f.block_timestamp)::bigint AS block_ts,
        COALESCE(r.trust_score, 50)::float AS reviewer_trust_score,
        COALESCE(f.is_sybil_flagged, FALSE) AS is_sybil_flagged
      FROM feedback f
      LEFT JOIN reviewers r ON lower(r.address) = lower(f.client_address)
      WHERE f.agent_id = $1 AND f.chain_id = $2 AND f.is_revoked = FALSE
    `,
    [agentId, chainId]
  );

  const nowMs = Date.now();
  const rows = feedbackRes.rows as Array<Record<string, unknown>>;

  if (SYBIL_DETECT_ENABLED && rows.length) {
    const burstExcluded = detectBurstAddresses(
      rows as Array<{ client_address: string; block_ts: number }>,
      SYBIL_BURST_WINDOW_SEC,
      SYBIL_BURST_THRESHOLD
    );

    if (burstExcluded.size) {
      const addrs = [...burstExcluded];
      await pool.query(
        `
          UPDATE feedback
          SET is_sybil_flagged = TRUE, updated_at = NOW()
          WHERE agent_id = $1
            AND chain_id = $2
            AND lower(client_address) = ANY($3::text[])
            AND COALESCE(is_sybil_flagged, FALSE) = FALSE
        `,
        [agentId, chainId, addrs]
      );

      await upsertSybilFlag({
        agentId,
        pattern: "burst_feedback",
        severity: "high",
        affectedAddresses: addrs,
        notes: `>=${SYBIL_BURST_THRESHOLD} feedback within ${SYBIL_BURST_WINDOW_SEC}s by a single reviewer`,
      });
    }

    const coordinated = detectCoordinatedTimingAddresses(
      rows as Array<{ client_address: string; block_ts: number }>,
      30,
      3
    );
    if (coordinated.size) {
      await upsertSybilFlag({
        agentId,
        pattern: "coordinated_timing",
        severity: "high",
        affectedAddresses: [...coordinated],
        notes: ">=3 unique reviewers posted feedback within a 30s window",
      });
    }
  }

  const reviewerSet = new Set<string>();
  let oldestTs: number | null = null;
  let newestTs: number | null = null;

  type Weighted = { tag1: string; normalized: number; weight: number };
  const weighted: Weighted[] = [];

  const burstExcluded = SYBIL_DETECT_ENABLED
    ? detectBurstAddresses(rows as Array<{ client_address: string; block_ts: number }>, SYBIL_BURST_WINDOW_SEC, SYBIL_BURST_THRESHOLD)
    : new Set<string>();

  for (const r of rows) {
    const client = String(r.client_address).toLowerCase();
    const isSybilFlagged = Boolean(r.is_sybil_flagged ?? false) || burstExcluded.has(client);
    if (isSybilFlagged) continue;

    reviewerSet.add(client);

    const blockTs = Number(r.block_ts ?? 0);
    if (oldestTs === null || blockTs < oldestTs) oldestTs = blockTs;
    if (newestTs === null || blockTs > newestTs) newestTs = blockTs;

    const tag1 = String(r.tag1 ?? "");
    const valueRaw = String(r.value_raw);
    const decimals = Number(r.value_decimals ?? 0);
    const trustScore = Number(r.reviewer_trust_score ?? 50);

    const trustWeight = trustScoreToWeight(trustScore);
    const decay = timeDecayWeight(blockTs, nowMs);
    const weight = trustWeight * decay;

    const normalized =
      tag1 === "revenues" || tag1 === "tradingYield" || tag1 === "paymentSuccess"
        ? normalizeEconomicValue(tag1, valueRaw, decimals, maxRev)
        : normalizeValue(valueRaw, decimals, tag1);

    weighted.push({ tag1, normalized, weight });
  }

  const feedbackCount = weighted.length;
  const reviewerCount = reviewerSet.size;
  const confidenceLevel = determineConfidence(feedbackCount, reviewerCount);

  const uptimeScore = weightedAverage(
    weighted.filter((w) => w.tag1 === "uptime" || w.tag1 === "reachable" || w.tag1 === "responseTime")
  );
  const qualityScore = weightedAverage(
    weighted.filter((w) => w.tag1 === "starred" || w.tag1 === "quality" || w.tag1 === "successRate")
  );
  const economicScore = weightedAverage(
    weighted.filter((w) => w.tag1 === "revenues" || w.tag1 === "tradingYield" || w.tag1 === "paymentSuccess")
  );

  const compositeScore = uptimeScore * 0.4 + qualityScore * 0.35 + economicScore * 0.25;

  // Trends (delta vs prior daily snapshot)
  const prev7d = await computeTrendDays(agentId, 7);
  const prev30d = await computeTrendDays(agentId, 30);
  const trend7d = compositeScore - prev7d;
  const trend30d = compositeScore - prev30d;

  await pool.query(
    `
      INSERT INTO agent_scores(
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
        oldest_feedback,
        newest_feedback,
        calculated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        CASE WHEN $12::bigint IS NULL THEN NULL ELSE to_timestamp($12) END,
        CASE WHEN $13::bigint IS NULL THEN NULL ELSE to_timestamp($13) END,
        NOW()
      )
      ON CONFLICT (agent_id)
      DO UPDATE SET
        chain_id = EXCLUDED.chain_id,
        uptime_score = EXCLUDED.uptime_score,
        quality_score = EXCLUDED.quality_score,
        economic_score = EXCLUDED.economic_score,
        composite_score = EXCLUDED.composite_score,
        trend_7d = EXCLUDED.trend_7d,
        trend_30d = EXCLUDED.trend_30d,
        feedback_count = EXCLUDED.feedback_count,
        reviewer_count = EXCLUDED.reviewer_count,
        confidence_level = EXCLUDED.confidence_level,
        oldest_feedback = EXCLUDED.oldest_feedback,
        newest_feedback = EXCLUDED.newest_feedback,
        calculated_at = NOW()
    `,
    [
      agentId,
      chainId,
      uptimeScore,
      qualityScore,
      economicScore,
      compositeScore,
      trend7d,
      trend30d,
      feedbackCount,
      reviewerCount,
      confidenceLevel,
      oldestTs,
      newestTs,
    ]
  );

  const intervalStartRes = await pool.query(`SELECT date_trunc('day', NOW()) AS day_start`);
  const dayStart = intervalStartRes.rows[0]?.day_start as Date | undefined;

  await pool.query(
    `
      INSERT INTO agent_scores_history(
        agent_id,
        interval_type,
        interval_start,
        uptime_score,
        quality_score,
        economic_score,
        composite_score,
        feedback_count
      ) VALUES (
        $1,'daily',$2,$3,$4,$5,$6,$7
      )
      ON CONFLICT (agent_id, interval_type, interval_start)
      DO UPDATE SET
        uptime_score = EXCLUDED.uptime_score,
        quality_score = EXCLUDED.quality_score,
        economic_score = EXCLUDED.economic_score,
        composite_score = EXCLUDED.composite_score,
        feedback_count = EXCLUDED.feedback_count
    `,
    [agentId, dayStart ?? new Date(), uptimeScore, qualityScore, economicScore, compositeScore, feedbackCount]
  );
}

function weightedAverage(items: Array<{ normalized: number; weight: number }>): number {
  if (!items.length) return 50;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const i of items) {
    weightedSum += i.normalized * i.weight;
    totalWeight += i.weight;
  }
  if (totalWeight <= 0) return 50;
  return weightedSum / totalWeight;
}

async function main(): Promise<void> {
  console.log(`score-calculator: refresh interval ${REFRESH_INTERVAL_MS}ms batch=${BATCH_SIZE}`);

  for (;;) {
    try {
      const maxRevByChain = await maxRevenueByChain();
      const agents = await agentsNeedingRecalc();
      for (const a of agents) {
        await calculateAndUpsertAgentScore(a.agent_id, a.chain_id, maxRevByChain.get(a.chain_id));
      }
      if (agents.length) console.log(`score-calculator: updated ${agents.length} agents`);
    } catch (err) {
      console.error(`score-calculator error: ${String(err)}`);
    }

    await new Promise((r) => setTimeout(r, REFRESH_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
