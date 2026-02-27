import { envInt, envOrDefault, fetchJsonWithKeccak, ipfsToGatewayUrl, makePgPool } from "@8004/shared";
import { createPublicClient, decodeEventLog, http, parseAbiItem, type PublicClient } from "viem";

const POLL_INTERVAL_MS = envInt("POLL_INTERVAL_MS", 30_000);
const IPFS_GATEWAY = envOrDefault("IPFS_GATEWAY", "https://gateway.pinata.cloud");

const CHAIN_ID = envInt("CHAIN_ID", 43113); // Avalanche Fuji by default
const RPC_URL = envOrDefault("RPC_URL", "https://api.avax-test.network/ext/bc/C/rpc");
const IDENTITY_REGISTRY_ADDRESS_RAW = envOrDefault("IDENTITY_REGISTRY_ADDRESS", "0x8004A818BFB912233c491871b3d84c89A494BD9e");
const REPUTATION_REGISTRY_ADDRESS_RAW = envOrDefault("REPUTATION_REGISTRY_ADDRESS", "0x8004B663056A597Dffe9eCcC1965A193B7388713");
const INGEST_FROM_BLOCK = envOrDefault("INGEST_FROM_BLOCK", "51544615");
const INGEST_LOG_CHUNK_BLOCKS = envOrDefault("INGEST_LOG_CHUNK_BLOCKS", "5000");
const INGEST_CONFIRMATIONS = envInt("INGEST_CONFIRMATIONS", 3);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asAddressLower(input: string, envName: string): `0x${string}` {
  const v = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Invalid ${envName}: expected 0x + 40 hex chars; got ${input}`);
  return v.toLowerCase() as `0x${string}`;
}

function parseBigintEnv(raw: string, envName: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Invalid ${envName}: empty`);
  try {
    return BigInt(trimmed);
  } catch {
    throw new Error(`Invalid ${envName}: expected integer string; got ${raw}`);
  }
}

const IDENTITY_REGISTRY_ADDRESS = asAddressLower(IDENTITY_REGISTRY_ADDRESS_RAW, "IDENTITY_REGISTRY_ADDRESS");
const REPUTATION_REGISTRY_ADDRESS = asAddressLower(REPUTATION_REGISTRY_ADDRESS_RAW, "REPUTATION_REGISTRY_ADDRESS");

// ERC-8004 (EIP-8004) ReputationRegistry event formats vary a bit across deployments.
// We fetch raw logs, then attempt decode with multiple plausible ABIs, catching per-log decode failures.
const newFeedbackEvents = [
  // int128 value + valueDecimals + feedbackURI + feedbackHash.
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  // int128 + metadataURI/hash (watchtower uses giveFeedback(..., metadataURI, metadataHash)).
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string comment, string metadataURI, bytes32 metadataHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string comment, string metadataURI, bytes32 metadataHash)"
  ),
  // uint8 score variant.
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, uint8 score, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, uint8 score, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  // Same shapes, but feedbackIndex is uint256.
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string comment, string metadataURI, bytes32 metadataHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string comment, string metadataURI, bytes32 metadataHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, uint8 score, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, uint8 score, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
  ),
  // Value as int256 (rare, but harmless to try).
  parseAbiItem(
    "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex, int256 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string metadataURI, bytes32 metadataHash)"
  ),
] as const;

const feedbackRevokedEvents = [
  parseAbiItem(
    "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)"
  ),
  parseAbiItem(
    "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex)"
  ),
  parseAbiItem(
    "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint256 indexed feedbackIndex)"
  ),
  parseAbiItem(
    "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint256 feedbackIndex)"
  ),
  // Some variants may omit clientAddress.
  parseAbiItem("event FeedbackRevoked(uint256 indexed agentId, uint64 indexed feedbackIndex)"),
  parseAbiItem("event FeedbackRevoked(uint256 indexed agentId, uint256 indexed feedbackIndex)"),
] as const;

const pool = makePgPool();

function makePublicClient(rpcUrl: string, chainId: number): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, { timeout: 30_000 }),
    chain: {
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
    }
  });
}

function computeAgentRegistryCaip(chainId: number, identityRegistryAddress: `0x${string}`): string {
  return `eip155:${chainId}:${identityRegistryAddress.toLowerCase()}`;
}

function computeAgentUid(agentRegistry: string, tokenId: bigint): string {
  return `${agentRegistry}:${tokenId.toString()}`;
}

async function ensureIngestState(chainId: number, fromBlock: bigint): Promise<void> {
  // Store last_scanned_block as "fromBlock - 1" so the first scan begins at fromBlock.
  const lastScanned = fromBlock > 0n ? fromBlock - 1n : 0n;
  await pool.query(
    `
      INSERT INTO ingest_state(chain_id, last_block_timestamp, last_scanned_block)
      VALUES ($1, 0, $2)
      ON CONFLICT (chain_id) DO NOTHING
    `,
    [chainId, lastScanned.toString()]
  );
}

async function getLastScannedBlock(chainId: number): Promise<bigint> {
  const res = await pool.query(
    `SELECT last_scanned_block FROM ingest_state WHERE chain_id = $1 LIMIT 1`,
    [chainId]
  );
  const raw = (res.rows[0]?.last_scanned_block as string | number | undefined) ?? "0";
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

async function setLastScannedBlock(chainId: number, blockNumber: bigint): Promise<void> {
  await pool.query(
    `
      UPDATE ingest_state
      SET last_scanned_block = $2, updated_at = NOW()
      WHERE chain_id = $1
    `,
    [chainId, blockNumber.toString()]
  );
}

async function upsertFeedback(args: {
  chainId: number;
  agentUid: string;
  clientAddress: string;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string | null;
  tag2: string | null;
  endpoint: string | null;
  feedbackURI: string | null;
  feedbackHash: string | null;
  isRevoked: boolean;
  blockNumber: bigint;
  blockTimestampSec: number;
  transactionHash: string;
  offChainData: unknown | null;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO feedback(
        chain_id,
        agent_id,
        client_address,
        feedback_index,
        value,
        value_decimals,
        tag1,
        tag2,
        endpoint,
        feedback_uri,
        feedback_hash,
        is_revoked,
        block_number,
        block_timestamp,
        transaction_hash,
        off_chain_data,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14),$15,$16,NOW()
      )
      ON CONFLICT (chain_id, agent_id, client_address, feedback_index)
      DO UPDATE SET
        value = EXCLUDED.value,
        value_decimals = EXCLUDED.value_decimals,
        tag1 = EXCLUDED.tag1,
        tag2 = EXCLUDED.tag2,
        endpoint = EXCLUDED.endpoint,
        feedback_uri = EXCLUDED.feedback_uri,
        feedback_hash = EXCLUDED.feedback_hash,
        is_revoked = EXCLUDED.is_revoked,
        block_number = EXCLUDED.block_number,
        block_timestamp = EXCLUDED.block_timestamp,
        transaction_hash = EXCLUDED.transaction_hash,
        off_chain_data = COALESCE(EXCLUDED.off_chain_data, feedback.off_chain_data),
        updated_at = NOW()
    `,
    [
      args.chainId,
      args.agentUid,
      args.clientAddress.toLowerCase(),
      args.feedbackIndex.toString(),
      args.value.toString(),
      args.valueDecimals,
      args.tag1,
      args.tag2,
      args.endpoint,
      args.feedbackURI,
      args.feedbackHash,
      args.isRevoked,
      args.blockNumber.toString(),
      args.blockTimestampSec,
      args.transactionHash,
      args.offChainData ? JSON.stringify(args.offChainData) : null,
    ]
  );
}

async function markRevoked(args: {
  chainId: number;
  agentUid: string;
  clientAddress: string;
  feedbackIndex: bigint;
}): Promise<void> {
  await pool.query(
    `
      UPDATE feedback
      SET is_revoked = TRUE, updated_at = NOW()
      WHERE chain_id = $1
        AND agent_id = $2
        AND lower(client_address) = $3
        AND feedback_index = $4
    `,
    [args.chainId, args.agentUid, args.clientAddress.toLowerCase(), args.feedbackIndex.toString()]
  );
}

async function markRevokedByIndex(args: { chainId: number; agentUid: string; feedbackIndex: bigint }): Promise<void> {
  await pool.query(
    `
      UPDATE feedback
      SET is_revoked = TRUE, updated_at = NOW()
      WHERE chain_id = $1
        AND agent_id = $2
        AND feedback_index = $3
    `,
    [args.chainId, args.agentUid, args.feedbackIndex.toString()]
  );
}

async function enrichOffChain(feedbackURI: string, feedbackHash: string | null): Promise<unknown | null> {
  const url = ipfsToGatewayUrl(feedbackURI, IPFS_GATEWAY);
  const { json, keccakHex } = await fetchJsonWithKeccak(url);

  if (feedbackHash && feedbackHash !== "0x" && !/^0x0+$/.test(feedbackHash)) {
    if (keccakHex.toLowerCase() !== feedbackHash.toLowerCase()) {
      console.warn(`IPFS hash mismatch: expected=${feedbackHash} got=${keccakHex} uri=${feedbackURI}`);
      return null;
    }
  }

  return json;
}

type UnifiedEvent =
  | {
      kind: "NewFeedback";
      agentId: bigint;
      clientAddress: string;
      feedbackIndex: bigint;
      value: bigint;
      valueDecimals: number;
      tag1: string;
      tag2: string;
      endpoint: string;
      feedbackURI: string;
      feedbackHash: string;
      blockNumber: bigint;
      logIndex: number;
      txHash: string;
    }
  | {
      kind: "FeedbackRevoked";
      agentId: bigint;
      clientAddress: string;
      feedbackIndex: bigint;
      blockNumber: bigint;
      logIndex: number;
      txHash: string;
    };

function uniqKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

async function fetchBlockTimestampsSec(client: PublicClient, blockNumbers: bigint[]): Promise<Map<string, number>> {
  const uniq = Array.from(new Set(blockNumbers.map((b) => b.toString())));
  const out = new Map<string, number>();

  for (const raw of uniq) {
    const bn = BigInt(raw);
    const b = await client.getBlock({ blockNumber: bn });
    const ts = Number(b.timestamp);
    out.set(raw, Number.isFinite(ts) ? ts : 0);
  }
  return out;
}

function toStringOrEmpty(v: unknown): string {
  if (typeof v === "string") return v;
  return "";
}

function toBigintOrUndefined(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && v.trim()) {
    try {
      return BigInt(v.trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeMaybeNullString(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

function normalizeTagMaybeHash(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  // Indexed string topics show up as 0x{32 bytes} (hash) and are not meaningful tags.
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return null;
  return t;
}

function extractStringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

async function fetchEvents(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<UnifiedEvent[]> {
  const logs = await client.getLogs({
    address: REPUTATION_REGISTRY_ADDRESS,
    fromBlock,
    toBlock,
  });

  const byKey = new Map<string, UnifiedEvent>();

  for (const l of logs as Array<Record<string, unknown>>) {
    const txHash = String(l.transactionHash ?? "");
    const logIndex = Number(l.logIndex ?? 0);
    const blockNumber = (l.blockNumber ?? 0n) as bigint;
    if (!txHash) continue;

    const key = uniqKey(txHash, logIndex);
    if (byKey.has(key)) continue;

    // Try NewFeedback candidates.
    for (const evAbi of newFeedbackEvents) {
      try {
        const decoded = decodeEventLog({
          abi: [evAbi],
          data: l.data as `0x${string}`,
          topics: l.topics as [] | [signature: `0x${string}`, ...`0x${string}`[]],
        }) as { eventName: string; args: Record<string, unknown> };

        if (decoded.eventName !== "NewFeedback") continue;

        const args = decoded.args;
        const agentId = args.agentId as bigint;
        const clientAddress = String(args.clientAddress ?? "");
        const feedbackIndex = (args.feedbackIndex ?? 0n) as bigint;
        const value =
          (toBigintOrUndefined(args.value) ??
            // Score-only variant.
            toBigintOrUndefined(args.score) ??
            0n) as bigint;
        const valueDecimals = Number(args.valueDecimals ?? 0);
        const tag1 = toStringOrEmpty(args.tag1);
        const tag2 = toStringOrEmpty(args.tag2);
        const endpoint = toStringOrEmpty(args.endpoint);
        const feedbackURI = toStringOrEmpty(args.feedbackURI ?? args.metadataURI);
        const feedbackHash = String(args.feedbackHash ?? args.metadataHash ?? "");

        const ev: UnifiedEvent = {
          kind: "NewFeedback",
          agentId,
          clientAddress,
          feedbackIndex,
          value,
          valueDecimals,
          tag1,
          tag2,
          endpoint,
          feedbackURI,
          feedbackHash,
          blockNumber,
          logIndex,
          txHash,
        };

        byKey.set(key, ev);
        break;
      } catch {
        // Keep trying other ABIs.
      }
    }

    if (byKey.has(key)) continue;

    // Try FeedbackRevoked candidates.
    for (const evAbi of feedbackRevokedEvents) {
      try {
        const decoded = decodeEventLog({
          abi: [evAbi],
          data: l.data as `0x${string}`,
          topics: l.topics as [] | [signature: `0x${string}`, ...`0x${string}`[]],
        }) as { eventName: string; args: Record<string, unknown> };

        if (decoded.eventName !== "FeedbackRevoked") continue;

        const args = decoded.args;
        const agentId = args.agentId as bigint;
        const clientAddress = String(args.clientAddress ?? "");
        const feedbackIndex = (args.feedbackIndex ?? 0n) as bigint;

        const ev: UnifiedEvent = {
          kind: "FeedbackRevoked",
          agentId,
          clientAddress,
          feedbackIndex,
          blockNumber,
          logIndex,
          txHash,
        };
        byKey.set(key, ev);
        break;
      } catch {
        // Keep trying other ABIs.
      }
    }
  }

  const events = [...byKey.values()];
  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return events;
}

async function processBlockRange(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<number> {
  const events = await fetchEvents(client, fromBlock, toBlock);
  if (!events.length) return 0;

  const tsByBlock = await fetchBlockTimestampsSec(
    client,
    events.map((e) => e.blockNumber)
  );

  const agentRegistryCaip = computeAgentRegistryCaip(CHAIN_ID, IDENTITY_REGISTRY_ADDRESS);

  for (const e of events) {
    const agentUid = computeAgentUid(agentRegistryCaip, e.agentId);

    if (e.kind === "FeedbackRevoked") {
      if (e.clientAddress) {
        await markRevoked({
          chainId: CHAIN_ID,
          agentUid,
          clientAddress: e.clientAddress,
          feedbackIndex: e.feedbackIndex,
        });
      } else {
        await markRevokedByIndex({ chainId: CHAIN_ID, agentUid, feedbackIndex: e.feedbackIndex });
      }
      continue;
    }

    const ts = tsByBlock.get(e.blockNumber.toString()) ?? 0;

    let offChainData: unknown | null = null;
    const feedbackURI = normalizeMaybeNullString(e.feedbackURI);
    const feedbackHash = normalizeMaybeNullString(e.feedbackHash);
    if (feedbackURI) {
      try {
        offChainData = await enrichOffChain(feedbackURI, feedbackHash);
      } catch (err) {
        console.warn(`Failed IPFS enrichment for ${agentUid} tx=${e.txHash}: ${String(err)}`);
      }
    }

    const tag1 = normalizeTagMaybeHash(e.tag1) ?? normalizeTagMaybeHash(extractStringField(offChainData, "tag1") ?? "");
    const tag2 = normalizeTagMaybeHash(e.tag2) ?? normalizeTagMaybeHash(extractStringField(offChainData, "tag2") ?? "");
    const endpoint =
      normalizeMaybeNullString(e.endpoint) ?? normalizeMaybeNullString(extractStringField(offChainData, "endpoint") ?? "");

    await upsertFeedback({
      chainId: CHAIN_ID,
      agentUid,
      clientAddress: e.clientAddress,
      feedbackIndex: e.feedbackIndex,
      value: e.value,
      valueDecimals: e.valueDecimals,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash,
      isRevoked: false,
      blockNumber: e.blockNumber,
      blockTimestampSec: ts,
      transactionHash: e.txHash,
      offChainData,
    });
  }

  return events.length;
}

async function main(): Promise<void> {
  const fromBlock = parseBigintEnv(INGEST_FROM_BLOCK, "INGEST_FROM_BLOCK");
  const chunkBlocks = parseBigintEnv(INGEST_LOG_CHUNK_BLOCKS, "INGEST_LOG_CHUNK_BLOCKS");

  console.log(
    `ingestion: chain=${CHAIN_ID} rpc=${RPC_URL} reputationRegistry=${REPUTATION_REGISTRY_ADDRESS} fromBlock=${fromBlock.toString()} poll=${POLL_INTERVAL_MS}ms chunk=${chunkBlocks.toString()} confirmations=${INGEST_CONFIRMATIONS}`
  );

  const client = makePublicClient(RPC_URL, CHAIN_ID);
  await ensureIngestState(CHAIN_ID, fromBlock);

  for (;;) {
    try {
      const latest = await client.getBlockNumber();
      const targetLatest = latest > BigInt(INGEST_CONFIRMATIONS) ? latest - BigInt(INGEST_CONFIRMATIONS) : 0n;

      const lastScanned = await getLastScannedBlock(CHAIN_ID);
      const start = lastScanned + 1n;
      if (start > targetLatest) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (let s = start; s <= targetLatest; s += chunkBlocks + 1n) {
        const e = s + chunkBlocks > targetLatest ? targetLatest : s + chunkBlocks;
        const processed = await processBlockRange(client, s, e);
        await setLastScannedBlock(CHAIN_ID, e);
        if (processed > 0) {
          console.log(`ingestion: processed ${processed} logs (blocks ${s.toString()}..${e.toString()})`);
        }
      }
    } catch (err) {
      console.error(`ingestion error: ${String(err)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
