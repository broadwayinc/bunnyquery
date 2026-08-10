/**
 * Engine configuration / dependency injection.
 *
 * The engine is framework- and transport-agnostic: it never imports a skapi
 * instance or `import.meta.env`. Each consumer calls `configureChatEngine()`
 * once at startup to inject the skapi transport functions, the MCP base URL,
 * and (optionally) the `poll` value to attach to clientSecretRequest.
 *
 * Why `poll` is configurable: agent.vue uses the npm-bundled skapi-js and OMITS
 * `poll` (its clientSecretRequest auto-resolves with the final body), whereas
 * the BunnyQuery widget uses the deployed skapi-js@latest and must pass
 * `poll: 0` to get the early ack + a manual `.poll()` handle (needed for queued-
 * send cancel). So the request builders include `poll` only when it is set.
 */

import { type AttachmentParser, registerAttachmentParser } from './attachment_parsers';

export interface ChatEngineConfig {
    /** skapi.clientSecretRequest, bound to the consumer's skapi instance. */
    clientSecretRequest: (opts: any) => Promise<any>;
    /** skapi.clientSecretRequestHistory, bound to the consumer's skapi instance. */
    clientSecretRequestHistory: (params: any, fetchOptions: any) => Promise<any>;
    /** MCP server base URL (prod vs dev resolved by the consumer). */
    mcpBaseUrl: string;
    /**
     * Value to attach as `poll` on every clientSecretRequest. When `undefined`
     * the `poll` key is omitted entirely (agent.vue). BunnyQuery sets `0`.
     */
    poll?: number;
    /**
     * Optional client-side attachment parsers (e.g. an .hwp parser). Each is
     * registered at configure time; more can be added later via
     * `registerAttachmentParser()`. See attachment_parsers.ts.
     */
    attachmentParsers?: AttachmentParser[];
    /**
     * Opt in to SERVER-DRIVEN windowed indexing for text/grid files.
     *
     * Off by default, and deliberately so. When on, the client emits a
     * `_skapi_window` directive and the WORKER reads the file one window at a time,
     * continuing until the reader says it is exhausted. When off, the agent pages the
     * file itself with readFileContent, exactly as before.
     *
     * The flag exists because the backend must ship FIRST: a client emitting the
     * directive against a worker that does not strip it leaves an unknown field in the
     * request body, and the provider rejects the whole call with no retry. Keep it off
     * until the worker is deployed, then flip it per environment.
     */
    windowedIndexing?: boolean;
    /**
     * Mint the durable "indexing finished" marker record ("done::<path>",
     * reference "src::<path>", table __INDEXING__ — same shape the backend
     * worker writes via /internal/index-complete) for runs whose completion
     * THIS CLIENT knows deterministically: a single-pass file's settled pass,
     * or a client-driven chain whose reply carried the completion token.
     * Worker-driven chains are NOT minted from the client (their completion is
     * only ever inferred here); the worker writes their marker itself.
     * Must be best-effort: tolerate the marker already existing and never
     * throw. Optional so older consumers keep the pre-marker inference.
     */
    mintIndexDoneMarker?: (info: { service: string; storagePath: string }) => void;
    /**
     * Create-or-update the per-file indexing RUN record ("run::<path>",
     * reference "src::<path>", table __INDEXING__). The record is the durable
     * "a run exists and this is its status" signal that lets chat rows and
     * files-page badges paint without scanning bg history.
     *
     * The consumer implements upsert semantics (the records API has none):
     * create, and on "is already taken" look the record up by unique_id and
     * re-post with its record_id, merging `patch` over the stored data.
     * Status precedence is the consumer's job too: 'working' must NEVER
     * overwrite a terminal status (done/error/cancelled) — a late create from
     * a slow enqueue must not resurrect a run another writer already closed.
     * Must be best-effort and never throw. Optional: without it the engine
     * behaves exactly as before (legacy scan/probe path).
     */
    upsertIndexRunRecord?: (info: {
        service: string;
        storagePath: string;
        patch: {
            status: 'working' | 'done' | 'error' | 'cancelled';
            filename?: string;
            started?: number;
            finished?: number;
            error?: string;
            queue?: string;
        };
    }) => void;
    /**
     * Single-item csr-poll point lookup (skapi.util.request('csr-poll', {id,
     * service, owner}, {auth:true})). For a RESOLVED item the backend returns
     * the provider response body itself; for a failed one, the resolved error.
     * Used by ChatSession.hydrateCompactItems to fetch the real bodies of
     * compact history stubs when the user expands an indexing row. Optional:
     * without it, stubs keep their server-extracted heads.
     */
    csrHistoryItemLookup?: (fullId: string, service: string, owner: string) => Promise<any>;
}

let _config: ChatEngineConfig | null = null;

export function configureChatEngine(config: ChatEngineConfig): void {
    _config = config;
    if (config.attachmentParsers) {
        for (const parser of config.attachmentParsers) registerAttachmentParser(parser);
    }
}

export function chatEngineConfig(): ChatEngineConfig {
    if (!_config) {
        throw new Error(
            '[chat-engine] configureChatEngine() must be called before using the engine.',
        );
    }
    return _config;
}

/** True when the consumer has opted in to server-driven windowed indexing. */
export function windowedIndexingEnabled(): boolean {
    return _config?.windowedIndexing === true;
}

/** Spread helper: `{ ...pollOpt() }` adds `poll` only when configured. */
export function pollOpt(): { poll?: number } {
    const p = _config?.poll;
    return p === undefined ? {} : { poll: p };
}
