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
