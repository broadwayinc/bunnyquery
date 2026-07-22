/**
 * AI base prompts — tweakable in one place, shared by both consumers.
 *   chat_system_prompt.ts     -> chat assistant (system prompt)
 *   indexing_system_prompt.ts -> background file-indexing agent (system prompt)
 *   indexing_user_message.ts  -> background file-indexing agent (user message)
 */

export { buildChatSystemPrompt, type ChatSystemPromptParams } from './chat_system_prompt';
export { buildIndexingSystemPrompt, type IndexingSystemPromptParams } from './indexing_system_prompt';
export {
	buildIndexingUserMessage,
	buildIndexingContinueMessage,
	buildIndexingRenderMessage,
	buildIndexingRenderContinueTemplate,
	buildIndexingWindowMessage,
	RENDER_FROM_TOKEN,
	type IndexingAttachmentInfo,
	type BuildIndexingUserMessageOptions,
} from './indexing_user_message';
