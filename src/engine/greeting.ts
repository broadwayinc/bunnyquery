/**
 * The chat's opening line, in ONE place.
 *
 * Both clients paint this bubble themselves (the widget builds DOM nodes,
 * agent.vue renders template markup) because the project name sits inside its
 * own translate="no" element. Forking the sentence between them is how the two
 * copies drifted before, so the sentence lives here and each client only
 * decides how to draw the three pieces.
 *
 * It is ALSO what the assistant is told it opened with (buildChatSystemPrompt's
 * `greeting`): the bubble is pure client-side chrome and never enters the
 * message history, so without this the model cannot answer "what do you mean,
 * indexed?" or "which files should I upload?" about its own first line.
 */

export type ChatGreetingParams = {
	/** Project display name. Rendered by the client inside translate="no". */
	projectName?: string;
	/**
	 * The project's own opening line, from the `chat_greeting` key of its
	 * bq::settings record. When set it REPLACES the built-in sentence outright,
	 * including the canUpload variants below: the owner wrote the words, so the
	 * client does not append instructions they chose not to give.
	 *
	 * It is returned as `lead` with an empty `name`/`tail`, so both clients draw
	 * it through the exact code path they already use for the default sentence.
	 * The project name is NOT interpolated into it -- an owner who wants their
	 * project named can type the name.
	 */
	custom?: string;
	/**
	 * Whether this session can attach files at all. False for an anonymous
	 * widget visitor and for a frozen database seen by a non-admin: telling
	 * those users to upload is a dead end, so they get the ask-first line.
	 */
	canUpload?: boolean;
};

export type ChatGreetingParts = {
	/** Text before the project name. */
	lead: string;
	/** The quoted project name, or "" when the project has no name. */
	name: string;
	/** Text after the project name. */
	tail: string;
	/** The whole line as plain text: what the assistant is told it said. */
	text: string;
};

export function buildChatGreeting(params: ChatGreetingParams): ChatGreetingParts {
	// A custom line short-circuits everything below. Trimmed because the setting
	// arrives from a textarea, and a value that is only whitespace means "unset"
	// rather than "open with a blank bubble".
	const custom = typeof params.custom === 'string' ? params.custom.trim() : '';
	if (custom) return { lead: custom, name: '', tail: '', text: custom };

	const name = params.projectName ? '"' + params.projectName + '"' : '';
	// canUpload is opt-out: a caller that does not know defaults to the
	// upload-first line, which is the right lead for every ordinary session.
	const lead = params.canUpload === false
		? 'Hi! Ask me anything about the data in your project'
		: 'Hi! Start by attaching the files related to your project';
	const tail = params.canUpload === false
		? '.'
		: ', or pasting plain text into the chat. Once they are indexed, ask me anything about that data.';
	return { lead, name, tail, text: lead + (name ? ' ' + name : '') + tail };
}
