# ERC-8004 Feedback Aggregator (MVP)

This repo implements a Phase 1 MVP of the **ERC-8004 Feedback Aggregator** described in `erc-8004-feedback-aggregator-architecture.md`.

## What’s Included

- PostgreSQL schema for:
  - raw feedback (`feedback`)
  - reviewer profiles (`reviewers`)
  - aggregated scores (`agent_scores`)
  - historical scores (`agent_scores_history`)
  - sybil flags (`sybil_flags`)
  - ingestion cursor (`ingest_state`)
- Services (TypeScript / Node):
  - `ingestion/`: polls ERC-8004 ReputationRegistry logs (Fuji RPC) and writes to Postgres (+ optional IPFS enrichment)
  - `trust-engine/`: recomputes reviewer profiles + trust scores from Postgres
  - `score-calculator/`: computes agent scores using time decay + trust weighting
  - `api/`: REST API for scores/feedback/leaderboard/reviewer profile

## Quick Start (Local Dev)

1. Create `.env` (see `.env.example`).
2. Start dependencies:
   - `docker compose up -d postgres redis`
3. Initialize schema:
   - On a fresh Postgres volume, `docker compose` auto-runs `db/schema.sql`.
   - If you already have a volume (or you changed the schema), run:
   - `npm install`
   - `npm -w @8004/shared run db:migrate`
4. Run services (separate terminals):
   - `npm -w @8004/api run dev`
   - `npm -w @8004/ingestion run dev`
   - `npm -w @8004/trust-engine run dev`
   - `npm -w @8004/score-calculator run dev`

API defaults to `http://localhost:3000`.

## Notes

- Fuji defaults:
  - `CHAIN_ID=43113`
  - `RPC_URL=https://api.avax-test.network/ext/bc/C/rpc`
  - `IDENTITY_REGISTRY_ADDRESS=0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - `REPUTATION_REGISTRY_ADDRESS=0x8004B663056A597Dffe9eCcC1965A193B7388713`
- Canonical `agentId` format in the API/DB is `eip155:<chainId>:<identityRegistry>:<tokenId>` (example: `eip155:43113:0x8004a818bfb912233c491871b3d84c89a494bd9e:123`).

## Upgrading From Legacy Agent IDs

Older versions used `agentId = "<chainId>:<tokenId>"`. Easiest migration is to wipe the Postgres volume.

If you need to keep data, you can update IDs in-place (example for Fuji IdentityRegistry):

```sql
-- feedback
UPDATE feedback
SET agent_id = 'eip155:' || chain_id::text || ':0x8004a818bfb912233c491871b3d84c89a494bd9e:' || split_part(agent_id, ':', 2)
WHERE agent_id ~ '^[0-9]+:[0-9]+$';

-- scores + history + sybil flags (if present)
UPDATE agent_scores
SET agent_id = 'eip155:' || chain_id::text || ':0x8004a818bfb912233c491871b3d84c89a494bd9e:' || split_part(agent_id, ':', 2)
WHERE agent_id ~ '^[0-9]+:[0-9]+$';

UPDATE agent_scores_history
SET agent_id = 'eip155:43113:0x8004a818bfb912233c491871b3d84c89a494bd9e:' || split_part(agent_id, ':', 2)
WHERE agent_id ~ '^[0-9]+:[0-9]+$';

UPDATE sybil_flags
SET agent_id = 'eip155:43113:0x8004a818bfb912233c491871b3d84c89a494bd9e:' || split_part(agent_id, ':', 2)
WHERE agent_id ~ '^[0-9]+:[0-9]+$';
```

## API Endpoints (MVP)

- `GET /health`
- `GET /v1/agents/:agentId/score`
- `GET /v1/agents/:agentId/feedback?trustedOnly=true&tag1=uptime&limit=50&offset=0`
- `GET /v1/agents/:agentId/history?interval=daily&from=...&to=...`
- `GET /v1/leaderboard?category=overall&limit=10`
- `GET /v1/search?minCompositeScore=80&sortBy=compositeScore&order=desc&limit=20`
- `GET /v1/reviewers/:address`
- `GET /v1/reviewers/:address/feedback?limit=50&offset=0`
