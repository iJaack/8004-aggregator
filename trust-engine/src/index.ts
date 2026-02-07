import { envInt, envOrDefault, makePgPool } from "@8004/shared";

const REFRESH_INTERVAL_MS = envInt("TRUST_REFRESH_INTERVAL_MS", 5 * 60_000);

const allowlistRaw = envOrDefault("WATCHTOWER_ALLOWLIST", "");
const watchtowerAllowlist = new Set(
  allowlistRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const pool = makePgPool();

function clamp0to100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function computeTrustScore(args: {
  firstFeedbackAt: Date | null;
  uniqueAgentsReviewed: number;
  revocationRate: number;
  isVerifiedWatchtower: boolean;
  paymentProofsCount: number;
  totalFeedbackGiven: number;
  topAgentFeedbackCount: number;
  firstWeekFeedbackCount: number;
  sybilFlaggedCount: number;
}): number {
  let score = 50;

  if (args.firstFeedbackAt) {
    const historyMs = Date.now() - args.firstFeedbackAt.getTime();
    const historyDays = historyMs / (1000 * 60 * 60 * 24);
    score += Math.min(20, (historyDays / 30) * 5);

    // Penalize brand-new accounts posting lots of feedback immediately.
    // This is a rough proxy for "account age" without on-chain identity checks.
    if (historyDays < 7 && args.totalFeedbackGiven > 5) {
      score -= 30;
    }
  }

  score += Math.min(15, args.uniqueAgentsReviewed * 0.5);

  // Payment verification (optional, via IPFS enriched off_chain_data).
  if (args.paymentProofsCount > 0) {
    score += Math.min(10, args.paymentProofsCount * 2);
  }

  // Penalize frequent revocations.
  score -= args.revocationRate * 20;

  // Single-agent focus heuristic: reviewers who almost exclusively rate one agent are lower-quality signals.
  if (args.totalFeedbackGiven >= 10) {
    const focusRatio = args.totalFeedbackGiven > 0 ? args.topAgentFeedbackCount / args.totalFeedbackGiven : 0;
    if (focusRatio > 0.9) score -= 15;
  }

  // Sybil feedback (agent-level) should strongly reduce reviewer trust.
  if (args.sybilFlaggedCount > 0) {
    score -= Math.min(40, args.sybilFlaggedCount * 5);
  }

  // Watchtower bonus.
  if (args.isVerifiedWatchtower) score += 20;

  return clamp0to100(score);
}

function tierFromScore(score: number, isVerifiedWatchtower: boolean, totalFeedbackGiven: number): string {
  if (totalFeedbackGiven <= 0) return "unknown";
  if (isVerifiedWatchtower) return "verified";
  if (score < 40) return "low";
  if (score < 60) return "medium";
  return "high";
}

async function recomputeAllReviewers(): Promise<void> {
  const res = await pool.query(
    `
      WITH per_reviewer AS (
        SELECT
          lower(client_address) AS address,
          COUNT(*)::int AS total_feedback_given,
          COUNT(DISTINCT agent_id)::int AS unique_agents_reviewed,
          MIN(block_timestamp) AS first_feedback_at,
          MAX(block_timestamp) AS last_feedback_at,
          SUM(CASE WHEN is_revoked THEN 1 ELSE 0 END)::int AS revoked_count,
          SUM(CASE WHEN off_chain_data->'proofOfPayment' IS NOT NULL THEN 1 ELSE 0 END)::int AS payment_proofs_count,
          SUM(CASE WHEN is_sybil_flagged THEN 1 ELSE 0 END)::int AS sybil_flagged_count
        FROM feedback
        GROUP BY lower(client_address)
      ),
      top_agent AS (
        SELECT address, MAX(agent_cnt)::int AS top_agent_feedback_count
        FROM (
          SELECT lower(client_address) AS address, agent_id, COUNT(*) AS agent_cnt
          FROM feedback
          GROUP BY lower(client_address), agent_id
        ) x
        GROUP BY address
      ),
      first_week AS (
        SELECT pr.address,
               COUNT(*)::int AS first_week_feedback_count
        FROM per_reviewer pr
        JOIN feedback f
          ON lower(f.client_address) = pr.address
         AND f.block_timestamp <= (pr.first_feedback_at + interval '7 days')
        GROUP BY pr.address
      )
      SELECT
        pr.address,
        pr.total_feedback_given,
        pr.unique_agents_reviewed,
        pr.first_feedback_at,
        pr.last_feedback_at,
        pr.revoked_count,
        pr.payment_proofs_count,
        pr.sybil_flagged_count,
        COALESCE(ta.top_agent_feedback_count, 0) AS top_agent_feedback_count,
        COALESCE(fw.first_week_feedback_count, 0) AS first_week_feedback_count
      FROM per_reviewer pr
      LEFT JOIN top_agent ta ON ta.address = pr.address
      LEFT JOIN first_week fw ON fw.address = pr.address
    `
  );

  for (const row of res.rows as Array<Record<string, unknown>>) {
    const address = String(row.address);
    const totalFeedbackGiven = Number(row.total_feedback_given ?? 0);
    const uniqueAgentsReviewed = Number(row.unique_agents_reviewed ?? 0);
    const firstFeedbackAt = (row.first_feedback_at as Date | null) ?? null;
    const lastFeedbackAt = (row.last_feedback_at as Date | null) ?? null;
    const revokedCount = Number(row.revoked_count ?? 0);
    const revocationRate = totalFeedbackGiven > 0 ? revokedCount / totalFeedbackGiven : 0;
    const paymentProofsCount = Number(row.payment_proofs_count ?? 0);
    const topAgentFeedbackCount = Number(row.top_agent_feedback_count ?? 0);
    const firstWeekFeedbackCount = Number(row.first_week_feedback_count ?? 0);
    const sybilFlaggedCount = Number(row.sybil_flagged_count ?? 0);

    const isVerifiedWatchtower = watchtowerAllowlist.has(address);
    const trustScore = computeTrustScore({
      firstFeedbackAt,
      uniqueAgentsReviewed,
      revocationRate,
      isVerifiedWatchtower,
      paymentProofsCount,
      totalFeedbackGiven,
      topAgentFeedbackCount,
      firstWeekFeedbackCount,
      sybilFlaggedCount,
    });
    const trustTier = tierFromScore(trustScore, isVerifiedWatchtower, totalFeedbackGiven);

    await pool.query(
      `
        INSERT INTO reviewers(
          address,
          total_feedback_given,
          unique_agents_reviewed,
          first_feedback_at,
          last_feedback_at,
          revocation_rate,
          is_verified_watchtower,
          payment_proofs_count,
          trust_score,
          trust_tier,
          updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()
        )
        ON CONFLICT (address)
        DO UPDATE SET
          total_feedback_given = EXCLUDED.total_feedback_given,
          unique_agents_reviewed = EXCLUDED.unique_agents_reviewed,
          first_feedback_at = EXCLUDED.first_feedback_at,
          last_feedback_at = EXCLUDED.last_feedback_at,
          revocation_rate = EXCLUDED.revocation_rate,
          is_verified_watchtower = EXCLUDED.is_verified_watchtower,
          payment_proofs_count = EXCLUDED.payment_proofs_count,
          trust_score = EXCLUDED.trust_score,
          trust_tier = EXCLUDED.trust_tier,
          updated_at = NOW()
      `,
      [
        address,
        totalFeedbackGiven,
        uniqueAgentsReviewed,
        firstFeedbackAt,
        lastFeedbackAt,
        revocationRate,
        isVerifiedWatchtower,
        paymentProofsCount,
        trustScore,
        trustTier,
      ]
    );
  }

  console.log(`trust-engine: updated ${res.rowCount} reviewers`);
}

async function main(): Promise<void> {
  console.log(`trust-engine: refresh interval ${REFRESH_INTERVAL_MS}ms`);

  for (;;) {
    try {
      await recomputeAllReviewers();
    } catch (err) {
      console.error(`trust-engine error: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, REFRESH_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
