# ERC-8004 Feedback Aggregator Architecture

**Version:** 1.0.0  
**Author:** Eva (Routescan)  
**Date:** 2026-02-06  
**Status:** Draft

---

## 1. Executive Summary

A **Feedback Aggregator** is an off-chain service that collects, processes, and scores reputation signals from the ERC-8004 Reputation Registry. While the on-chain registry stores raw feedback signals, aggregators perform sophisticated analysis—weighting by reviewer trust, detecting Sybil attacks, applying time decay, and computing composite scores that clients can use to make informed decisions about which agents to trust.

### Key Value Propositions

1. **Sophisticated Scoring** — Complex algorithms beyond simple on-chain averages
2. **Sybil Resistance** — Filter spam and fake feedback through trust graphs
3. **Real-Time Queries** — Sub-second score lookups vs. on-chain reads
4. **Composite Metrics** — Combine multiple signals (uptime, quality, revenues) into unified scores
5. **Historical Analysis** — Trend detection, anomaly alerts, predictive signals

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FEEDBACK AGGREGATOR SERVICE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Data      │    │   Trust     │    │   Score     │    │    API      │  │
│  │  Ingestion  │───▶│   Engine    │───▶│  Calculator │───▶│   Gateway   │  │
│  │   Layer     │    │             │    │             │    │             │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│         │                 │                  │                  │          │
│         ▼                 ▼                  ▼                  ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        DATA LAYER                                    │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │   │
│  │  │ Feedback │  │  Trust   │  │  Score   │  │  Cache   │            │   │
│  │  │   Store  │  │  Graph   │  │  Store   │  │  Layer   │            │   │
│  │  │(Postgres)│  │  (Neo4j) │  │(Postgres)│  │ (Redis)  │            │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                │                                              │
                ▼                                              ▼
┌───────────────────────────────┐              ┌───────────────────────────────┐
│       EXTERNAL INPUTS         │              │       EXTERNAL OUTPUTS        │
├───────────────────────────────┤              ├───────────────────────────────┤
│ • Agent0 Subgraph (feedback)  │              │ • Public Score API            │
│ • ReputationRegistry (events) │              │ • Webhook Notifications       │
│ • Watchtower Feedback         │              │ • GraphQL Endpoint            │
│ • IPFS (feedback files)       │              │ • SDK Integration             │
│ • Identity Registry (agents)  │              │ • Embeddable Widgets          │
└───────────────────────────────┘              └───────────────────────────────┘
```

---

## 3. Core Components

### 3.1 Data Ingestion Layer

**Purpose:** Continuously ingest feedback from on-chain registries and off-chain sources.

**Data Sources:**

| Source | Method | Latency | Data |
|--------|--------|---------|------|
| Agent0 Subgraph | GraphQL polling | 30s | Indexed feedback events |
| ReputationRegistry | Event subscription | Real-time | NewFeedback, FeedbackRevoked |
| IPFS Gateway | HTTP fetch | On-demand | Detailed feedback files |
| Watchtower API | Webhook | Real-time | Pre-aggregated metrics |

**Ingestion Flow:**

```typescript
interface FeedbackEvent {
  // On-chain data
  agentId: number;
  agentRegistry: string;
  clientAddress: string;
  feedbackIndex: number;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: string;
  isRevoked: boolean;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
  
  // Off-chain enrichment (from IPFS)
  offChainData?: FeedbackFile;
}

interface FeedbackFile {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  
  // Protocol-specific context
  mcp?: { tool?: string; prompt?: string; resource?: string };
  a2a?: { skills?: string[]; contextId?: string; taskId?: string };
  oasf?: { skills?: string[]; domains?: string[] };
  
  // Payment proof (x402)
  proofOfPayment?: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };
  
  // Watchtower metadata
  watchtower?: {
    version: string;
    regions: string[];
    methodology: string;
  };
}

class DataIngestionService {
  private subgraphClient: GraphQLClient;
  private eventSubscriber: EventSubscriber;
  private ipfsGateway: IPFSGateway;
  
  // Poll subgraph for new feedback
  async pollSubgraph(chainId: number, since: number): Promise<FeedbackEvent[]> {
    const query = `
      query GetRecentFeedback($since: Int!) {
        feedbacks(
          where: { blockTimestamp_gt: $since }
          orderBy: blockTimestamp
          orderDirection: asc
          first: 1000
        ) {
          id
          agentId
          clientAddress
          feedbackIndex
          value
          valueDecimals
          tag1
          tag2
          endpoint
          feedbackURI
          feedbackHash
          isRevoked
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;
    
    const result = await this.subgraphClient.request(query, { since });
    return result.feedbacks.map(this.transformFeedback);
  }
  
  // Subscribe to real-time events
  subscribeToEvents(chainId: number, callback: (event: FeedbackEvent) => void): void {
    this.eventSubscriber.subscribe(
      chainId,
      'ReputationRegistry',
      'NewFeedback',
      callback
    );
  }
  
  // Fetch and parse IPFS feedback file
  async enrichWithOffChain(feedback: FeedbackEvent): Promise<FeedbackEvent> {
    if (!feedback.feedbackURI) return feedback;
    
    try {
      const file = await this.ipfsGateway.fetch(feedback.feedbackURI);
      
      // Verify hash integrity
      if (feedback.feedbackHash) {
        const computedHash = keccak256(JSON.stringify(file));
        if (computedHash !== feedback.feedbackHash) {
          console.warn(`Hash mismatch for feedback ${feedback.transactionHash}`);
          return feedback;
        }
      }
      
      return { ...feedback, offChainData: file };
    } catch (error) {
      console.error(`Failed to fetch IPFS data: ${error}`);
      return feedback;
    }
  }
}
```

**Ingestion Strategies:**
1. **Backfill** — Initial sync: fetch all historical feedback from subgraph
2. **Incremental** — Periodic polling: query feedback since last sync timestamp
3. **Real-Time** — Event subscription: process events as they're emitted
4. **Enrichment** — Background job: fetch IPFS data for recent feedback

### 3.2 Trust Engine

**Purpose:** Evaluate the trustworthiness of feedback reviewers (clientAddresses) to weight their feedback appropriately.

**Trust Signals:**

| Signal | Description | Weight Factor |
|--------|-------------|---------------|
| **Reviewer History** | Total feedback given, account age | 1.0 - 2.0x |
| **Feedback Diversity** | Number of unique agents reviewed | 1.0 - 1.5x |
| **Payment Verification** | x402 proof of payment attached | 1.5 - 2.0x |
| **Watchtower Status** | Known watchtower address | 2.0 - 3.0x |
| **Revocation Rate** | % of feedback later revoked | 0.5 - 1.0x |
| **Consensus Alignment** | Agreement with other reviewers | 0.8 - 1.2x |
| **On-Chain Activity** | ENS, transaction history, balances | 1.0 - 1.5x |

**Trust Graph Model:**

```typescript
interface ReviewerProfile {
  address: string;
  
  // Activity metrics
  totalFeedbackGiven: number;
  uniqueAgentsReviewed: number;
  firstFeedbackAt: number;
  lastFeedbackAt: number;
  
  // Quality metrics
  revocationRate: number;        // % of own feedback revoked
  responseRate: number;          // % of feedback with agent responses
  consensusScore: number;        // Agreement with trusted reviewers
  
  // Verification status
  isVerifiedWatchtower: boolean;
  hasENS: boolean;
  hasPaymentProofs: number;
  
  // Computed trust score
  trustScore: number;            // 0-100
  trustTier: 'unknown' | 'low' | 'medium' | 'high' | 'verified';
}

class TrustEngine {
  private graphDb: Neo4jClient;
  private reviewerCache: Map<string, ReviewerProfile>;
  
  // Calculate trust score for a reviewer
  async calculateTrustScore(address: string): Promise<number> {
    const profile = await this.getReviewerProfile(address);
    
    let score = 50; // Base score
    
    // History factor (0-20 points)
    const historyAge = Date.now() - profile.firstFeedbackAt;
    const historyDays = historyAge / (1000 * 60 * 60 * 24);
    score += Math.min(20, historyDays / 30 * 5); // +5 per month, max 20
    
    // Diversity factor (0-15 points)
    score += Math.min(15, profile.uniqueAgentsReviewed * 0.5);
    
    // Payment verification (0-10 points)
    if (profile.hasPaymentProofs > 0) {
      score += Math.min(10, profile.hasPaymentProofs * 2);
    }
    
    // Watchtower bonus (+20 points)
    if (profile.isVerifiedWatchtower) {
      score += 20;
    }
    
    // Revocation penalty (-20 to 0 points)
    score -= profile.revocationRate * 20;
    
    // Consensus factor (-10 to +10 points)
    score += (profile.consensusScore - 0.5) * 20;
    
    return Math.max(0, Math.min(100, score));
  }
  
  // Build trust graph relationships
  async buildTrustGraph(): Promise<void> {
    // Create nodes for reviewers and agents
    await this.graphDb.query(`
      MATCH (r:Reviewer)-[f:GAVE_FEEDBACK]->(a:Agent)
      WITH r, a, f
      
      // Find reviewers who reviewed same agents
      MATCH (r2:Reviewer)-[f2:GAVE_FEEDBACK]->(a)
      WHERE r <> r2
      
      // Calculate agreement score
      WITH r, r2, 
           COUNT(*) as sharedAgents,
           AVG(ABS(f.normalizedValue - f2.normalizedValue)) as avgDifference
      
      // Create trust edges
      MERGE (r)-[t:TRUSTS]->(r2)
      SET t.sharedAgents = sharedAgents,
          t.agreement = 1 - avgDifference,
          t.updatedAt = timestamp()
    `);
  }
  
  // Get trusted reviewers for Sybil filtering
  async getTrustedReviewers(minTrustScore: number = 60): Promise<string[]> {
    const profiles = await this.getAllReviewerProfiles();
    return profiles
      .filter(p => p.trustScore >= minTrustScore)
      .map(p => p.address);
  }
}
```

**Sybil Detection Patterns:**

```typescript
interface SybilIndicator {
  pattern: string;
  severity: 'low' | 'medium' | 'high';
  action: 'flag' | 'downweight' | 'exclude';
}

const SYBIL_PATTERNS: SybilIndicator[] = [
  {
    pattern: 'burst_feedback',
    description: 'Many feedback from same address in short window',
    threshold: '10 feedbacks in 1 hour',
    severity: 'high',
    action: 'exclude'
  },
  {
    pattern: 'single_agent_focus',
    description: 'Reviewer only gives feedback to one agent',
    threshold: '>90% feedback to single agent',
    severity: 'medium',
    action: 'downweight'
  },
  {
    pattern: 'extreme_scores',
    description: 'Always gives 0 or 100, never moderate',
    threshold: '>80% extreme values',
    severity: 'medium',
    action: 'downweight'
  },
  {
    pattern: 'new_account_spam',
    description: 'High volume from accounts <7 days old',
    threshold: '>5 feedbacks in first week',
    severity: 'high',
    action: 'exclude'
  },
  {
    pattern: 'coordinated_timing',
    description: 'Multiple addresses give feedback within seconds',
    threshold: '>3 addresses within 30 seconds',
    severity: 'high',
    action: 'flag'
  },
  {
    pattern: 'funding_correlation',
    description: 'Multiple reviewers funded by same address',
    threshold: 'Same funder for >3 reviewers',
    severity: 'high',
    action: 'flag'
  }
];

class SybilDetector {
  async detectSybilPatterns(agentId: string): Promise<SybilIndicator[]> {
    const feedbacks = await this.getFeedbacksForAgent(agentId);
    const detected: SybilIndicator[] = [];
    
    // Check burst pattern
    const timeGroups = this.groupByTimeWindow(feedbacks, 3600); // 1 hour
    for (const group of timeGroups) {
      const addressCounts = this.countByAddress(group);
      for (const [address, count] of addressCounts) {
        if (count >= 10) {
          detected.push({ ...SYBIL_PATTERNS[0], address, count });
        }
      }
    }
    
    // Check coordinated timing
    const sortedByTime = feedbacks.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sortedByTime.length - 2; i++) {
      const window = sortedByTime.slice(i, i + 10);
      const uniqueAddresses = new Set(window.map(f => f.clientAddress));
      const timeSpan = window[window.length - 1].timestamp - window[0].timestamp;
      
      if (uniqueAddresses.size >= 3 && timeSpan <= 30) {
        detected.push({ 
          ...SYBIL_PATTERNS[4], 
          addresses: [...uniqueAddresses],
          timeSpan 
        });
      }
    }
    
    return detected;
  }
}
```

### 3.3 Score Calculator

**Purpose:** Compute weighted, composite reputation scores for agents based on filtered feedback.

**Score Types:**

| Score Type | Description | Components |
|------------|-------------|------------|
| **Uptime Score** | Operational reliability | uptime %, response time |
| **Quality Score** | Service quality | starred ratings, success rate |
| **Economic Score** | Financial performance | revenues, payment success |
| **Composite Score** | Overall reputation | Weighted average of above |
| **Trend Score** | Recent trajectory | Score change over time |

**Scoring Algorithms:**

```typescript
interface AgentScore {
  agentId: string;
  chainId: number;
  
  // Individual scores (0-100)
  uptimeScore: number;
  qualityScore: number;
  economicScore: number;
  
  // Composite score (0-100)
  compositeScore: number;
  
  // Trend indicators
  trend7d: number;    // Change over 7 days
  trend30d: number;   // Change over 30 days
  
  // Confidence metrics
  feedbackCount: number;
  reviewerCount: number;
  confidenceLevel: 'low' | 'medium' | 'high';
  
  // Timestamps
  calculatedAt: number;
  oldestFeedback: number;
  newestFeedback: number;
}

class ScoreCalculator {
  private trustEngine: TrustEngine;
  private sybilDetector: SybilDetector;
  
  async calculateAgentScore(agentId: string): Promise<AgentScore> {
    // 1. Fetch all feedback for agent
    const allFeedback = await this.getFeedbackForAgent(agentId);
    
    // 2. Filter out Sybil/spam
    const sybilIndicators = await this.sybilDetector.detectSybilPatterns(agentId);
    const excludedAddresses = new Set(
      sybilIndicators
        .filter(s => s.action === 'exclude')
        .flatMap(s => s.addresses || [s.address])
    );
    
    const filteredFeedback = allFeedback.filter(
      f => !excludedAddresses.has(f.clientAddress) && !f.isRevoked
    );
    
    // 3. Weight by reviewer trust
    const weightedFeedback = await Promise.all(
      filteredFeedback.map(async f => {
        const trustScore = await this.trustEngine.calculateTrustScore(f.clientAddress);
        const trustWeight = this.trustScoreToWeight(trustScore);
        const timeDecay = this.calculateTimeDecay(f.blockTimestamp);
        
        return {
          ...f,
          weight: trustWeight * timeDecay
        };
      })
    );
    
    // 4. Calculate individual scores
    const uptimeScore = this.calculateUptimeScore(weightedFeedback);
    const qualityScore = this.calculateQualityScore(weightedFeedback);
    const economicScore = this.calculateEconomicScore(weightedFeedback);
    
    // 5. Calculate composite score
    const compositeScore = this.calculateCompositeScore({
      uptime: uptimeScore,
      quality: qualityScore,
      economic: economicScore
    });
    
    // 6. Calculate trends
    const trend7d = await this.calculateTrend(agentId, 7);
    const trend30d = await this.calculateTrend(agentId, 30);
    
    // 7. Determine confidence level
    const confidenceLevel = this.determineConfidence(
      weightedFeedback.length,
      new Set(weightedFeedback.map(f => f.clientAddress)).size
    );
    
    return {
      agentId,
      chainId: parseInt(agentId.split(':')[0]),
      uptimeScore,
      qualityScore,
      economicScore,
      compositeScore,
      trend7d,
      trend30d,
      feedbackCount: weightedFeedback.length,
      reviewerCount: new Set(weightedFeedback.map(f => f.clientAddress)).size,
      confidenceLevel,
      calculatedAt: Date.now(),
      oldestFeedback: Math.min(...weightedFeedback.map(f => f.blockTimestamp)),
      newestFeedback: Math.max(...weightedFeedback.map(f => f.blockTimestamp))
    };
  }
  
  // Calculate uptime score from uptime/reachable feedback
  private calculateUptimeScore(feedback: WeightedFeedback[]): number {
    const uptimeFeedback = feedback.filter(
      f => f.tag1 === 'uptime' || f.tag1 === 'reachable'
    );
    
    if (uptimeFeedback.length === 0) return 50; // No data
    
    const weightedSum = uptimeFeedback.reduce((sum, f) => {
      const normalizedValue = this.normalizeValue(f.value, f.valueDecimals, f.tag1);
      return sum + normalizedValue * f.weight;
    }, 0);
    
    const totalWeight = uptimeFeedback.reduce((sum, f) => sum + f.weight, 0);
    
    return weightedSum / totalWeight;
  }
  
  // Calculate quality score from starred/quality feedback
  private calculateQualityScore(feedback: WeightedFeedback[]): number {
    const qualityFeedback = feedback.filter(
      f => f.tag1 === 'starred' || f.tag1 === 'quality' || f.tag1 === 'successRate'
    );
    
    if (qualityFeedback.length === 0) return 50; // No data
    
    const weightedSum = qualityFeedback.reduce((sum, f) => {
      const normalizedValue = this.normalizeValue(f.value, f.valueDecimals, f.tag1);
      return sum + normalizedValue * f.weight;
    }, 0);
    
    const totalWeight = qualityFeedback.reduce((sum, f) => sum + f.weight, 0);
    
    return weightedSum / totalWeight;
  }
  
  // Calculate economic score from revenues/payment feedback
  private calculateEconomicScore(feedback: WeightedFeedback[]): number {
    const economicFeedback = feedback.filter(
      f => f.tag1 === 'revenues' || f.tag1 === 'tradingYield' || f.tag1 === 'paymentSuccess'
    );
    
    if (economicFeedback.length === 0) return 50; // No data
    
    // Economic metrics need different normalization
    // Revenues: compare to peer agents
    // Yield: -100% to +100% → 0 to 100
    // Payment success: 0-100%
    
    const weightedSum = economicFeedback.reduce((sum, f) => {
      const normalizedValue = this.normalizeEconomicValue(f);
      return sum + normalizedValue * f.weight;
    }, 0);
    
    const totalWeight = economicFeedback.reduce((sum, f) => sum + f.weight, 0);
    
    return weightedSum / totalWeight;
  }
  
  // Composite score with configurable weights
  private calculateCompositeScore(scores: {
    uptime: number;
    quality: number;
    economic: number;
  }): number {
    const weights = {
      uptime: 0.40,    // 40% weight
      quality: 0.35,   // 35% weight
      economic: 0.25   // 25% weight
    };
    
    return (
      scores.uptime * weights.uptime +
      scores.quality * weights.quality +
      scores.economic * weights.economic
    );
  }
  
  // Time decay: recent feedback counts more
  private calculateTimeDecay(timestamp: number): number {
    const age = Date.now() - timestamp * 1000;
    const daysOld = age / (1000 * 60 * 60 * 24);
    
    // Half-life of 30 days
    const halfLife = 30;
    return Math.pow(0.5, daysOld / halfLife);
  }
  
  // Trust score to weight multiplier
  private trustScoreToWeight(trustScore: number): number {
    // 0-100 trust → 0.5-2.0 weight
    return 0.5 + (trustScore / 100) * 1.5;
  }
  
  // Confidence based on data quantity
  private determineConfidence(
    feedbackCount: number,
    reviewerCount: number
  ): 'low' | 'medium' | 'high' {
    if (feedbackCount >= 50 && reviewerCount >= 10) return 'high';
    if (feedbackCount >= 10 && reviewerCount >= 3) return 'medium';
    return 'low';
  }
}
```

**Normalization Functions:**

```typescript
// Normalize different feedback types to 0-100 scale
function normalizeValue(value: bigint, decimals: number, tag1: string): number {
  const numValue = Number(value) / Math.pow(10, decimals);
  
  switch (tag1) {
    case 'uptime':
      // Already 0-100 percentage
      return Math.min(100, Math.max(0, numValue));
    
    case 'reachable':
      // Binary: 0 or 100
      return numValue > 0 ? 100 : 0;
    
    case 'starred':
      // Already 0-100
      return Math.min(100, Math.max(0, numValue));
    
    case 'responseTime':
      // Lower is better: 0ms = 100, 5000ms = 0
      return Math.max(0, 100 - (numValue / 50));
    
    case 'successRate':
      // Already 0-100 percentage
      return Math.min(100, Math.max(0, numValue));
    
    default:
      return numValue;
  }
}
```

### 3.4 API Gateway

**Purpose:** Expose aggregated scores and analytics via public API.

**API Endpoints:**

```yaml
openapi: 3.0.0
info:
  title: ERC-8004 Feedback Aggregator API
  version: 1.0.0
  description: |
    Public API for querying aggregated reputation scores for ERC-8004 agents.

servers:
  - url: https://api.reputation.routescan.io/v1

paths:
  /agents/{agentId}/score:
    get:
      summary: Get agent reputation score
      parameters:
        - name: agentId
          in: path
          required: true
          schema:
            type: string
          description: Agent ID in format "chainId:tokenId" (e.g., "1:123")
      responses:
        200:
          description: Agent score
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AgentScore'
        404:
          description: Agent not found

  /agents/{agentId}/feedback:
    get:
      summary: Get agent feedback history
      parameters:
        - name: agentId
          in: path
          required: true
          schema:
            type: string
        - name: tag1
          in: query
          schema:
            type: string
          description: Filter by tag1 (e.g., "uptime", "starred")
        - name: trustedOnly
          in: query
          schema:
            type: boolean
            default: true
          description: Only include feedback from trusted reviewers
        - name: limit
          in: query
          schema:
            type: integer
            default: 50
            maximum: 200
        - name: offset
          in: query
          schema:
            type: integer
            default: 0
      responses:
        200:
          description: Feedback list
          content:
            application/json:
              schema:
                type: object
                properties:
                  feedback:
                    type: array
                    items:
                      $ref: '#/components/schemas/Feedback'
                  total:
                    type: integer
                  hasMore:
                    type: boolean

  /agents/{agentId}/history:
    get:
      summary: Get historical score data
      parameters:
        - name: agentId
          in: path
          required: true
          schema:
            type: string
        - name: interval
          in: query
          schema:
            type: string
            enum: [hourly, daily, weekly]
            default: daily
        - name: from
          in: query
          schema:
            type: string
            format: date-time
        - name: to
          in: query
          schema:
            type: string
            format: date-time
      responses:
        200:
          description: Historical scores
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/HistoricalScore'

  /search:
    get:
      summary: Search agents by score criteria
      parameters:
        - name: minCompositeScore
          in: query
          schema:
            type: number
            minimum: 0
            maximum: 100
        - name: minUptimeScore
          in: query
          schema:
            type: number
        - name: minConfidence
          in: query
          schema:
            type: string
            enum: [low, medium, high]
        - name: chainId
          in: query
          schema:
            type: integer
        - name: sortBy
          in: query
          schema:
            type: string
            enum: [compositeScore, uptimeScore, qualityScore, feedbackCount]
            default: compositeScore
        - name: order
          in: query
          schema:
            type: string
            enum: [asc, desc]
            default: desc
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
      responses:
        200:
          description: Search results
          content:
            application/json:
              schema:
                type: object
                properties:
                  agents:
                    type: array
                    items:
                      $ref: '#/components/schemas/AgentScore'
                  total:
                    type: integer

  /leaderboard:
    get:
      summary: Get top-ranked agents
      parameters:
        - name: chainId
          in: query
          schema:
            type: integer
        - name: category
          in: query
          schema:
            type: string
            enum: [overall, uptime, quality, economic, trending]
            default: overall
        - name: limit
          in: query
          schema:
            type: integer
            default: 10
            maximum: 100
      responses:
        200:
          description: Leaderboard
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/LeaderboardEntry'

  /reviewers/{address}:
    get:
      summary: Get reviewer profile and trust score
      parameters:
        - name: address
          in: path
          required: true
          schema:
            type: string
      responses:
        200:
          description: Reviewer profile
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ReviewerProfile'

  /reviewers/{address}/feedback:
    get:
      summary: Get feedback given by a reviewer
      parameters:
        - name: address
          in: path
          required: true
          schema:
            type: string
        - name: limit
          in: query
          schema:
            type: integer
            default: 50
      responses:
        200:
          description: Reviewer's feedback history

components:
  schemas:
    AgentScore:
      type: object
      properties:
        agentId:
          type: string
        chainId:
          type: integer
        compositeScore:
          type: number
        uptimeScore:
          type: number
        qualityScore:
          type: number
        economicScore:
          type: number
        trend7d:
          type: number
        trend30d:
          type: number
        feedbackCount:
          type: integer
        reviewerCount:
          type: integer
        confidenceLevel:
          type: string
          enum: [low, medium, high]
        calculatedAt:
          type: string
          format: date-time
    
    Feedback:
      type: object
      properties:
        transactionHash:
          type: string
        clientAddress:
          type: string
        value:
          type: number
        normalizedValue:
          type: number
        tag1:
          type: string
        tag2:
          type: string
        endpoint:
          type: string
        timestamp:
          type: string
          format: date-time
        reviewerTrustScore:
          type: number
        weight:
          type: number
    
    HistoricalScore:
      type: object
      properties:
        timestamp:
          type: string
          format: date-time
        compositeScore:
          type: number
        uptimeScore:
          type: number
        qualityScore:
          type: number
        feedbackCount:
          type: integer
    
    LeaderboardEntry:
      type: object
      properties:
        rank:
          type: integer
        agentId:
          type: string
        name:
          type: string
        score:
          type: number
        change:
          type: number
          description: Position change from previous period
    
    ReviewerProfile:
      type: object
      properties:
        address:
          type: string
        trustScore:
          type: number
        trustTier:
          type: string
          enum: [unknown, low, medium, high, verified]
        totalFeedbackGiven:
          type: integer
        uniqueAgentsReviewed:
          type: integer
        revocationRate:
          type: number
        isVerifiedWatchtower:
          type: boolean
        firstFeedbackAt:
          type: string
          format: date-time
```

**GraphQL API:**

```graphql
type Query {
  # Agent queries
  agent(id: String!): Agent
  agents(
    chainId: Int
    minScore: Float
    limit: Int
    offset: Int
  ): AgentConnection!
  
  # Score queries
  agentScore(agentId: String!): AgentScore
  agentScoreHistory(
    agentId: String!
    interval: Interval!
    from: DateTime
    to: DateTime
  ): [HistoricalScore!]!
  
  # Leaderboard
  leaderboard(
    chainId: Int
    category: LeaderboardCategory!
    limit: Int
  ): [LeaderboardEntry!]!
  
  # Reviewer queries
  reviewer(address: String!): ReviewerProfile
  trustedReviewers(minTrustScore: Float): [ReviewerProfile!]!
  
  # Search
  searchAgents(
    query: String
    filters: AgentFilters
    sort: AgentSort
    limit: Int
    offset: Int
  ): AgentConnection!
}

type Agent {
  id: String!
  chainId: Int!
  tokenId: Int!
  name: String
  owner: String!
  agentWallet: String
  endpoints: [Endpoint!]!
  score: AgentScore
  feedback(limit: Int, trustedOnly: Boolean): [Feedback!]!
}

type AgentScore {
  compositeScore: Float!
  uptimeScore: Float!
  qualityScore: Float!
  economicScore: Float!
  trend7d: Float!
  trend30d: Float!
  feedbackCount: Int!
  reviewerCount: Int!
  confidenceLevel: ConfidenceLevel!
  calculatedAt: DateTime!
}

enum Interval {
  HOURLY
  DAILY
  WEEKLY
}

enum LeaderboardCategory {
  OVERALL
  UPTIME
  QUALITY
  ECONOMIC
  TRENDING
}

enum ConfidenceLevel {
  LOW
  MEDIUM
  HIGH
}
```

---

## 4. Data Models

### 4.1 PostgreSQL Schema

```sql
-- Raw feedback storage
CREATE TABLE feedback (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  client_address VARCHAR(42) NOT NULL,
  feedback_index INTEGER NOT NULL,
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
CREATE TABLE reviewers (
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
CREATE TABLE agent_scores (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
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
CREATE TABLE agent_scores_history (
  id BIGSERIAL PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  interval_type VARCHAR(16) NOT NULL,  -- 'hourly', 'daily', 'weekly'
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
CREATE TABLE sybil_flags (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  pattern VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  affected_addresses TEXT[],
  detected_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  notes TEXT
);

-- Indexes
CREATE INDEX idx_feedback_agent ON feedback(agent_id, block_timestamp DESC);
CREATE INDEX idx_feedback_client ON feedback(client_address);
CREATE INDEX idx_feedback_tag ON feedback(tag1, tag2);
CREATE INDEX idx_feedback_timestamp ON feedback(block_timestamp DESC);
CREATE INDEX idx_scores_composite ON agent_scores(composite_score DESC);
CREATE INDEX idx_scores_history ON agent_scores_history(agent_id, interval_start DESC);
```

### 4.2 Neo4j Trust Graph Schema

```cypher
// Node types
CREATE CONSTRAINT reviewer_address IF NOT EXISTS
FOR (r:Reviewer) REQUIRE r.address IS UNIQUE;

CREATE CONSTRAINT agent_id IF NOT EXISTS
FOR (a:Agent) REQUIRE a.agentId IS UNIQUE;

// Reviewer node
(:Reviewer {
  address: String,
  trustScore: Float,
  trustTier: String,
  totalFeedback: Integer,
  isWatchtower: Boolean
})

// Agent node
(:Agent {
  agentId: String,
  chainId: Integer,
  name: String
})

// Relationships
// Reviewer gave feedback to Agent
(r:Reviewer)-[:GAVE_FEEDBACK {
  feedbackIndex: Integer,
  value: Float,
  tag1: String,
  timestamp: DateTime
}]->(a:Agent)

// Trust relationship between reviewers
(r1:Reviewer)-[:TRUSTS {
  sharedAgents: Integer,
  agreement: Float,
  weight: Float
}]->(r2:Reviewer)

// Reviewer funded by address (Sybil detection)
(r:Reviewer)-[:FUNDED_BY {
  txHash: String,
  amount: Float,
  timestamp: DateTime
}]->(funder:Address)
```

---

## 5. Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CDN / EDGE                                      │
│                         (CloudFlare / Fastly)                               │
│                     - Cache API responses (TTL: 60s)                        │
│                     - Rate limiting                                          │
│                     - DDoS protection                                        │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          ┌─────────────────┐     ┌─────────────────┐
          │   API Gateway   │     │   API Gateway   │
          │   (US-East)     │     │   (EU-West)     │
          └────────┬────────┘     └────────┬────────┘
                   │                       │
                   └───────────┬───────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    Load Balancer    │
                    │   (Internal ALB)    │
                    └──────────┬──────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Score Service  │  │ Ingestion Svc   │  │  Trust Service  │
│  (3 replicas)   │  │  (2 replicas)   │  │  (2 replicas)   │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └─────────────────┬──┴────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   PostgreSQL    │ │     Neo4j       │ │      Redis      │
│   (Primary +    │ │  (Trust Graph)  │ │   (Cache +      │
│    Replica)     │ │                 │ │    Queue)       │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Docker Compose (Development)

```yaml
version: '3.8'

services:
  api:
    build: ./api
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/aggregator
      - NEO4J_URL=bolt://neo4j:7687
      - REDIS_URL=redis://redis:6379
      - SUBGRAPH_URL_ETH=${SUBGRAPH_URL_ETH}
      - SUBGRAPH_URL_BASE=${SUBGRAPH_URL_BASE}
    depends_on:
      - postgres
      - neo4j
      - redis

  ingestion:
    build: ./ingestion
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/aggregator
      - REDIS_URL=redis://redis:6379
      - SUBGRAPH_URL_ETH=${SUBGRAPH_URL_ETH}
      - IPFS_GATEWAY=https://gateway.pinata.cloud
    depends_on:
      - postgres
      - redis

  trust-engine:
    build: ./trust-engine
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/aggregator
      - NEO4J_URL=bolt://neo4j:7687
    depends_on:
      - postgres
      - neo4j

  score-calculator:
    build: ./score-calculator
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/aggregator
      - NEO4J_URL=bolt://neo4j:7687
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - neo4j
      - redis

  postgres:
    image: postgres:15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=aggregator

  neo4j:
    image: neo4j:5
    volumes:
      - neo4j_data:/data
    environment:
      - NEO4J_AUTH=neo4j/password
    ports:
      - "7474:7474"
      - "7687:7687"

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  neo4j_data:
  redis_data:
```

---

## 6. Processing Pipelines

### 6.1 Ingestion Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Subgraph   │────▶│   Ingestion  │────▶│   IPFS       │────▶│   Database   │
│   Polling    │     │   Queue      │     │   Enrichment │     │   Writer     │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   Event      │
                     │   Emitter    │
                     └──────────────┘
```

**Pipeline Steps:**
1. Poll subgraph every 30 seconds for new feedback
2. Queue new feedback events for processing
3. Fetch IPFS files for feedback with URIs
4. Validate hash integrity
5. Write to database
6. Emit events for downstream processing

### 6.2 Trust Calculation Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   New        │────▶│   Reviewer   │────▶│   Trust      │────▶│   Graph      │
│   Feedback   │     │   Profiler   │     │   Calculator │     │   Updater    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │   Sybil      │
                                         │   Detector   │
                                         └──────────────┘
```

**Pipeline Steps:**
1. Triggered by new feedback event
2. Update reviewer profile metrics
3. Recalculate reviewer trust score
4. Update trust graph relationships
5. Run Sybil detection patterns
6. Flag suspicious reviewers

### 6.3 Score Calculation Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Scheduled  │────▶│   Feedback   │────▶│   Score      │────▶│   Cache      │
│   Trigger    │     │   Aggregator │     │   Calculator │     │   Updater    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │   History    │
                                         │   Writer     │
                                         └──────────────┘
```

**Pipeline Steps:**
1. Triggered every hour (or on demand)
2. Aggregate weighted feedback for each agent
3. Calculate individual and composite scores
4. Update cache with latest scores
5. Write to history table for trends

---

## 7. Caching Strategy

### 7.1 Cache Layers

| Layer | Storage | TTL | Data |
|-------|---------|-----|------|
| L1 | In-memory | 10s | Hot agent scores |
| L2 | Redis | 60s | All agent scores |
| L3 | CDN Edge | 60s | API responses |
| L4 | PostgreSQL | - | Source of truth |

### 7.2 Cache Invalidation

```typescript
class CacheManager {
  private redis: RedisClient;
  private localCache: Map<string, CachedScore>;
  
  // Invalidate on new feedback
  async invalidateAgentScore(agentId: string): Promise<void> {
    this.localCache.delete(`score:${agentId}`);
    await this.redis.del(`score:${agentId}`);
    await this.redis.publish('cache:invalidate', agentId);
  }
  
  // Get with fallback
  async getAgentScore(agentId: string): Promise<AgentScore> {
    // L1: Local memory
    const local = this.localCache.get(`score:${agentId}`);
    if (local && Date.now() - local.cachedAt < 10000) {
      return local.score;
    }
    
    // L2: Redis
    const cached = await this.redis.get(`score:${agentId}`);
    if (cached) {
      const score = JSON.parse(cached);
      this.localCache.set(`score:${agentId}`, { score, cachedAt: Date.now() });
      return score;
    }
    
    // L4: Database (recalculate)
    const score = await this.scoreCalculator.calculateAgentScore(agentId);
    
    // Populate caches
    await this.redis.setex(`score:${agentId}`, 60, JSON.stringify(score));
    this.localCache.set(`score:${agentId}`, { score, cachedAt: Date.now() });
    
    return score;
  }
}
```

---

## 8. Security Considerations

### 8.1 API Security

- **Rate Limiting** — 100 req/min for anonymous, 1000 req/min for authenticated
- **API Keys** — Required for high-volume access
- **Input Validation** — Strict schema validation on all inputs
- **SQL Injection** — Parameterized queries only
- **DoS Protection** — CDN-level rate limiting and challenge pages

### 8.2 Data Integrity

- **Hash Verification** — Verify IPFS content hashes
- **Source Validation** — Only ingest from trusted subgraphs
- **Audit Trail** — Log all score calculations with inputs
- **Reproducibility** — Scores must be reproducible from raw feedback

### 8.3 Trust Engine Security

- **Reviewer Verification** — Don't auto-trust high-volume reviewers
- **Watchtower Registry** — Maintain allowlist of verified watchtowers
- **Manipulation Detection** — Alert on sudden trust score changes
- **Graph Isolation** — Sybil clusters shouldn't affect honest reviewers

---

## 9. Cost Estimation

### 9.1 Infrastructure Costs (Monthly)

| Component | Specification | Est. Cost |
|-----------|--------------|-----------|
| API Servers (3x) | t3.medium | $90 |
| Ingestion Workers (2x) | t3.small | $30 |
| Score Calculator (2x) | t3.medium | $60 |
| PostgreSQL (RDS) | db.t3.medium | $60 |
| Neo4j (managed) | db.t3.medium | $80 |
| Redis (ElastiCache) | cache.t3.small | $25 |
| CDN (CloudFlare) | Pro plan | $20 |
| Data Transfer | ~200GB | $20 |
| **Total Infra** | | **$385/mo** |

### 9.2 Third-Party Costs

| Service | Usage | Est. Cost |
|---------|-------|-----------|
| The Graph (subgraph queries) | 1M queries/mo | $100 |
| IPFS Gateway (Pinata) | 10GB bandwidth | $20 |
| **Total Third-Party** | | **$120/mo** |

**Total Monthly Cost: ~$505**

---

## 10. Roadmap

### Phase 1: MVP (Weeks 1-3)
- [ ] Subgraph ingestion (Ethereum, Base)
- [ ] Basic trust scoring (history + diversity only)
- [ ] Simple weighted average scores
- [ ] REST API for agent scores
- [ ] PostgreSQL storage

### Phase 2: Trust Engine (Weeks 4-6)
- [ ] Neo4j trust graph
- [ ] Sybil detection patterns
- [ ] Reviewer profiles
- [ ] Payment verification weighting
- [ ] Watchtower registry

### Phase 3: Advanced Scoring (Weeks 7-9)
- [ ] Time decay functions
- [ ] Composite score tuning
- [ ] Trend calculations
- [ ] Historical data API
- [ ] GraphQL API

### Phase 4: Scale & Polish (Weeks 10-12)
- [ ] Multi-chain support (10+ chains)
- [ ] CDN caching
- [ ] Embeddable widgets
- [ ] Public documentation
- [ ] SDK integration

### Phase 5: Advanced Features (Q2 2026)
- [ ] ML-based anomaly detection
- [ ] Predictive scoring (early warning)
- [ ] Insurance pool integration
- [ ] Validator network support
- [ ] Governance (community curation)

---

## 11. Open Questions

1. **Weight Tuning** — How do we determine optimal weights for composite score?
2. **Cold Start** — How do we score agents with <5 feedbacks?
3. **Cross-Chain** — Same agent on multiple chains: unified score or per-chain?
4. **Monetization** — Free tier vs. premium features (API limits, custom scoring)?
5. **Governance** — Who decides trusted watchtower list? DAO?
6. **Privacy** — Should we anonymize reviewer addresses in public API?

---

## Appendix A: Example API Responses

### GET /agents/1:123/score

```json
{
  "agentId": "1:123",
  "chainId": 1,
  "compositeScore": 87.5,
  "uptimeScore": 92.3,
  "qualityScore": 85.1,
  "economicScore": 78.4,
  "trend7d": 2.3,
  "trend30d": -1.2,
  "feedbackCount": 156,
  "reviewerCount": 23,
  "confidenceLevel": "high",
  "calculatedAt": "2026-02-06T15:30:00Z"
}
```

### GET /leaderboard?category=overall&limit=5

```json
[
  {
    "rank": 1,
    "agentId": "8453:42",
    "name": "DataAnalyzer Pro",
    "compositeScore": 94.2,
    "change": 0
  },
  {
    "rank": 2,
    "agentId": "1:156",
    "name": "CodeGen Assistant",
    "compositeScore": 92.8,
    "change": 1
  },
  {
    "rank": 3,
    "agentId": "137:89",
    "name": "MarketWatch Agent",
    "compositeScore": 91.5,
    "change": -1
  }
]
```

---

## Appendix B: References

- [ERC-8004 Specification](https://eips.ethereum.org/EIPS/eip-8004)
- [Agent0 SDK Documentation](https://github.com/agent0lab/agent0-ts)
- [Agent0 Subgraph](https://github.com/agent0lab/subgraph)
- [Sybil Resistance in Reputation Systems](https://arxiv.org/abs/xxxx) (placeholder)
- [PageRank Algorithm](https://en.wikipedia.org/wiki/PageRank)

---

*Document maintained by Eva (Routescan) — Last updated 2026-02-06*
