-- ERC-8004 Feedback Aggregator schema (MVP)

-- Raw feedback storage
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  agent_id VARCHAR(256) NOT NULL,
  client_address VARCHAR(42) NOT NULL,
  feedback_index BIGINT NOT NULL,
  value NUMERIC NOT NULL,
  value_decimals INTEGER NOT NULL,
  tag1 VARCHAR(64),
  tag2 VARCHAR(64),
  endpoint TEXT,
  feedback_uri TEXT,
  feedback_hash VARCHAR(66),
  is_revoked BOOLEAN DEFAULT FALSE,
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMP NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,

  -- Off-chain enrichment
  off_chain_data JSONB,

  -- Processing metadata
  trust_weight DECIMAL(5,4),
  time_decay DECIMAL(5,4),
  normalized_value DECIMAL(5,2),
  is_sybil_flagged BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(chain_id, agent_id, client_address, feedback_index)
);

-- Reviewer profiles
CREATE TABLE IF NOT EXISTS reviewers (
  address VARCHAR(42) PRIMARY KEY,

  -- Activity metrics
  total_feedback_given INTEGER DEFAULT 0,
  unique_agents_reviewed INTEGER DEFAULT 0,
  first_feedback_at TIMESTAMP,
  last_feedback_at TIMESTAMP,

  -- Quality metrics
  revocation_rate DECIMAL(5,4) DEFAULT 0,
  response_rate DECIMAL(5,4) DEFAULT 0,
  consensus_score DECIMAL(5,4) DEFAULT 0.5,

  -- Verification
  is_verified_watchtower BOOLEAN DEFAULT FALSE,
  has_ens BOOLEAN DEFAULT FALSE,
  payment_proofs_count INTEGER DEFAULT 0,

  -- Computed scores
  trust_score DECIMAL(5,2) DEFAULT 50,
  trust_tier VARCHAR(16) DEFAULT 'unknown',

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Aggregated scores
CREATE TABLE IF NOT EXISTS agent_scores (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(256) NOT NULL,
  chain_id INTEGER NOT NULL,

  -- Individual scores
  uptime_score DECIMAL(5,2),
  quality_score DECIMAL(5,2),
  economic_score DECIMAL(5,2),
  composite_score DECIMAL(5,2),

  -- Trends
  trend_7d DECIMAL(5,2),
  trend_30d DECIMAL(5,2),

  -- Confidence
  feedback_count INTEGER,
  reviewer_count INTEGER,
  confidence_level VARCHAR(16),

  -- Time range
  oldest_feedback TIMESTAMP,
  newest_feedback TIMESTAMP,
  calculated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(agent_id)
);

-- Historical scores (for trend analysis)
CREATE TABLE IF NOT EXISTS agent_scores_history (
  id BIGSERIAL PRIMARY KEY,
  agent_id VARCHAR(256) NOT NULL,
  interval_type VARCHAR(16) NOT NULL, -- 'hourly', 'daily', 'weekly'
  interval_start TIMESTAMP NOT NULL,

  uptime_score DECIMAL(5,2),
  quality_score DECIMAL(5,2),
  economic_score DECIMAL(5,2),
  composite_score DECIMAL(5,2),
  feedback_count INTEGER,

  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(agent_id, interval_type, interval_start)
);

-- Sybil detection flags
CREATE TABLE IF NOT EXISTS sybil_flags (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(256) NOT NULL,
  pattern VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  affected_addresses TEXT[],
  detected_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  notes TEXT
);

-- Ingestion cursor (per chain)
CREATE TABLE IF NOT EXISTS ingest_state (
  chain_id INTEGER PRIMARY KEY,
  last_block_timestamp INTEGER NOT NULL DEFAULT 0,
  last_scanned_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- In case a DB was initialized with an earlier schema.sql, apply a few safe upgrades.
ALTER TABLE feedback ALTER COLUMN agent_id TYPE VARCHAR(256);
ALTER TABLE agent_scores ALTER COLUMN agent_id TYPE VARCHAR(256);
ALTER TABLE agent_scores_history ALTER COLUMN agent_id TYPE VARCHAR(256);
ALTER TABLE sybil_flags ALTER COLUMN agent_id TYPE VARCHAR(256);

ALTER TABLE feedback ALTER COLUMN feedback_index TYPE BIGINT;
ALTER TABLE ingest_state ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT NOT NULL DEFAULT 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_feedback_agent ON feedback(agent_id, block_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_client ON feedback(client_address);
CREATE INDEX IF NOT EXISTS idx_feedback_tag ON feedback(tag1, tag2);
CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback(block_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scores_composite ON agent_scores(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_history ON agent_scores_history(agent_id, interval_start DESC);
-- Only one active (unresolved) flag per (agent, pattern); keeps sybil detector idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sybil_flags_active
  ON sybil_flags(agent_id, pattern)
  WHERE resolved_at IS NULL;
