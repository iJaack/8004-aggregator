export type ConfidenceLevel = "low" | "medium" | "high";
export type TrustTier = "unknown" | "low" | "medium" | "high" | "verified";

export interface FeedbackFile {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;

  mcp?: { tool?: string; prompt?: string; resource?: string };
  a2a?: { skills?: string[]; contextId?: string; taskId?: string };
  oasf?: { skills?: string[]; domains?: string[] };

  proofOfPayment?: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };

  watchtower?: {
    version: string;
    regions: string[];
    methodology: string;
  };
}

export interface IngestedFeedbackEvent {
  chainId: number;
  agentId: string; // canonical: "eip155:<chainId>:<identityRegistry>:<tokenId>"
  clientAddress: string;
  feedbackIndex: number;
  value: string; // numeric string (can be big / negative)
  valueDecimals: number;
  tag1: string | null;
  tag2: string | null;
  endpoint: string | null;
  feedbackURI: string | null;
  feedbackHash: string | null;
  isRevoked: boolean;
  blockNumber: string;
  blockTimestamp: number; // seconds since epoch
  transactionHash: string;
  offChainData?: unknown;
}

export interface ReviewerProfile {
  address: string;
  totalFeedbackGiven: number;
  uniqueAgentsReviewed: number;
  firstFeedbackAt: string | null;
  lastFeedbackAt: string | null;
  revocationRate: number;
  isVerifiedWatchtower: boolean;
  trustScore: number;
  trustTier: TrustTier;
}

export interface AgentScore {
  agentId: string;
  chainId: number;
  uptimeScore: number;
  qualityScore: number;
  economicScore: number;
  compositeScore: number;
  trend7d: number;
  trend30d: number;
  feedbackCount: number;
  reviewerCount: number;
  confidenceLevel: ConfidenceLevel;
  calculatedAt: string;
  oldestFeedback: string | null;
  newestFeedback: string | null;
}
