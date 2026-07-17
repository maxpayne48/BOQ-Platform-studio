/**
 * RecommendationLogger (implemented)
 *
 * Makes every recommendation RecommendationEngineV2 produces auditable: who/what it was
 * for, where its rate came from, which decision rule applied, and how long it took.
 *
 * Performance contract: logRecommendation() is synchronous from the caller's point of
 * view - it returns immediately after an in-memory push, and never allocates a Promise the
 * caller is expected to await. The actual disk write happens asynchronously, in the
 * background, chained after any prior pending write so records stay in order without ever
 * blocking or slowing down the recommendation pipeline that calls it.
 *
 * Persistence is append-only JSON Lines (one record per line), not the read-whole-array/
 * rewrite-whole-array pattern used by KnowledgeBaseEngine's store - an audit log is
 * inherently append-only (records are never edited or deleted), so appending a single line
 * is both the correct semantics and, unlike a full-array rewrite, stays O(1) per entry
 * regardless of how large the log grows.
 *
 * Scope note: this file is implemented standalone and is not wired into
 * RecommendationEngineV2 this pass, since no connection was requested and every other
 * completed engine has been left untouched once frozen - see the accompanying summary.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export type RecommendationSourceLabel = "HISTORICAL_RATE" | "BASIC_RATE" | "NONE";
export type MatchTypeLabel = "EXACT_MATCH" | "SPECIFICATION_MATCH" | "MATERIAL_MATCH" | "PARTIAL_MATCH" | "NO_MATCH";

/** What a caller supplies for one recommendation event. Timestamp is stamped by the logger
 *  itself; user falls back to the logger's configured default when omitted. */
export interface RecommendationLogInput {
  rfqId: string;
  itemId: string;
  recommendationSource: RecommendationSourceLabel;
  historicalProject?: string;
  worksheet?: string;
  rowNumber?: number;
  historicalRate?: number;
  basicRate?: number;
  matchType: MatchTypeLabel;
  confidence?: number;
  decisionRuleApplied: string;
  user?: string;
  processingTimeMs: number;
}

/** The persisted shape - one line of the JSONL audit log, and one element of every query result. */
export interface RecommendationAuditRecord {
  rfqId: string;
  itemId: string;
  timestamp: string;
  recommendationSource: RecommendationSourceLabel;
  historicalProject?: string;
  worksheet?: string;
  rowNumber?: number;
  historicalRate?: number;
  basicRate?: number;
  matchType: MatchTypeLabel;
  confidence?: number;
  decisionRuleApplied: string;
  user: string;
  processingTimeMs: number;
}

export interface RecommendationLoggerOptions {
  logFilePath?: string;
  defaultUser?: string;
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IRecommendationLogger {
  /**
   * Fire-and-forget by design: returns immediately (an in-memory push, not a Promise the
   * caller must await) so it can never add latency to the recommendation pipeline. The
   * actual disk append happens asynchronously in the background.
   */
  logRecommendation(input: RecommendationLogInput): void;

  getEntriesForItem(rfqId: string, itemId: string): Promise<RecommendationAuditRecord[]>;
  getEntriesForRFQ(rfqId: string): Promise<RecommendationAuditRecord[]>;
  getAllEntries(): Promise<RecommendationAuditRecord[]>;

  /** Waits for all pending background writes to finish - for tests/shutdown only, never for the hot path. */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LOG_FILE_PATH = path.join(process.cwd(), "backend", "data", "recommendation-audit-log.jsonl");
const DEFAULT_USER = "system";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RecommendationLogger implements IRecommendationLogger {
  private readonly logFilePath: string;
  private readonly defaultUser: string;

  private readonly buffer: RecommendationAuditRecord[] = [];
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(options: RecommendationLoggerOptions = {}) {
    this.logFilePath = options.logFilePath ?? DEFAULT_LOG_FILE_PATH;
    this.defaultUser = options.defaultUser ?? DEFAULT_USER;

    // Loaded synchronously, once, at construction - never lazily on first query. A lazy
    // load triggered after logRecommendation() has already appended records to this same
    // file would re-read those same records back off disk and duplicate them into the
    // buffer that already holds them in memory. Doing this one-time startup read
    // synchronously (as KnowledgeBaseEngine already does for its own store) eliminates that
    // race entirely: no logRecommendation() call can occur before the constructor -
    // and therefore this load - has completed.
    this.loadFromDiskSync();
  }

  logRecommendation(input: RecommendationLogInput): void {
    const record: RecommendationAuditRecord = {
      rfqId: input.rfqId,
      itemId: input.itemId,
      timestamp: new Date().toISOString(),
      recommendationSource: input.recommendationSource,
      historicalProject: input.historicalProject,
      worksheet: input.worksheet,
      rowNumber: input.rowNumber,
      historicalRate: input.historicalRate,
      basicRate: input.basicRate,
      matchType: input.matchType,
      confidence: input.confidence,
      decisionRuleApplied: input.decisionRuleApplied,
      user: input.user ?? this.defaultUser,
      processingTimeMs: input.processingTimeMs
    };

    // Instant, synchronous, safe for the hot path - the caller's function returns without
    // ever waiting on I/O.
    this.buffer.push(record);

    // Chained (not awaited) so concurrent recommendations still append in the order they
    // were logged, and one failed write is isolated from the next rather than aborting it.
    this.pendingWrites = this.pendingWrites
      .then(() => this.appendToDisk(record))
      .catch((error) => {
        console.error("[RecommendationLogger] Failed to persist audit record (non-fatal):", error);
      });
  }

  private async appendToDisk(record: RecommendationAuditRecord): Promise<void> {
    const dir = path.dirname(this.logFilePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(this.logFilePath, JSON.stringify(record) + "\n", "utf-8");
  }

  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  private loadFromDiskSync(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const raw = fs.readFileSync(this.logFilePath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          this.buffer.push(JSON.parse(line));
        } catch {
          // Skip a malformed line rather than failing the whole load.
        }
      }
    } catch (error) {
      console.error("[RecommendationLogger] Failed to load existing audit log (starting empty):", error);
    }
  }

  async getEntriesForItem(rfqId: string, itemId: string): Promise<RecommendationAuditRecord[]> {
    return this.buffer.filter((record) => record.rfqId === rfqId && record.itemId === itemId);
  }

  async getEntriesForRFQ(rfqId: string): Promise<RecommendationAuditRecord[]> {
    return this.buffer.filter((record) => record.rfqId === rfqId);
  }

  async getAllEntries(): Promise<RecommendationAuditRecord[]> {
    return [...this.buffer];
  }
}
