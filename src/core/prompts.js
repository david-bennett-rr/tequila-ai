// Prompts Module - Centralized prompt templates for easy editing
const Prompts = (function() {

    // ============= PERSONA =============
    // Static defaults used when Storage isn't available yet
    const DEFAULT_STYLE = "Be BRIEF. 2-3 sentences MAX. Speak 95% English, but mix in a touch of Spanish on occasion.";
    const DEFAULT_RULES = `
        CRITICAL: Keep responses SHORT - 2-3 sentences only, NEVER more.
        CRITICAL: ONLY discuss Cuervo, no other tequila families.
        No emojis. Be casual and warm.
        Answer directly, don't over-explain or ramble.
        If asked a yes/no question, start with yes or no.
        Remember what the guest said before.
        Only respond when directly spoken to.
        `;
    const DEFAULT_USER_LABEL = "Guest";
    const DEFAULT_ASSISTANT_LABEL = "You";

    // Get current persona from storage (or defaults)
    const getPersona = () => {
        if (typeof Storage !== 'undefined' && Storage.getCurrentPersona) {
            const stored = Storage.getCurrentPersona();
            return {
                name: stored.name || "Fermenter",
                role: stored.role || "a tequila fermenter living in La Rojena, the oldest distillery in N. America",
                style: DEFAULT_STYLE,
                rules: DEFAULT_RULES,
                userLabel: DEFAULT_USER_LABEL,
                assistantLabel: DEFAULT_ASSISTANT_LABEL
            };
        }
        // Fallback if Storage not loaded yet
        return {
            name: "Fermenter",
            role: "a tequila fermenter living in La Rojena, the oldest distillery in N. America",
            style: DEFAULT_STYLE,
            rules: DEFAULT_RULES,
            userLabel: DEFAULT_USER_LABEL,
            assistantLabel: DEFAULT_ASSISTANT_LABEL
        };
    };

    // For backwards compatibility - returns current persona
    const PERSONA = getPersona();

    // ============= TEMPLATE BUILDERS =============

    // Build realtime instructions dynamically (includes summary for context)
    const getRealtimeInstructions = () => {
        const p = getPersona();
        const summary = (typeof Summary !== 'undefined' && Summary.summary) ? Summary.summary : '';
        return `You are ${p.role}. ${p.style} IMPORTANT: Keep ALL replies to 1-2 sentences maximum. Never give long explanations. Be concise and direct.

Background knowledge:
${summary}`;
    };

    // Build the final prompt for instruct models
    // Variables: {summary}, {history}, {text}
    const buildInstructPrompt = (text, summary, history) => {
        const p = getPersona();
        const template = `You're ${p.role}. ${p.style}

Rules: ${p.rules}

Background: {summary}

{history}${p.userLabel}: {text}
${p.assistantLabel}:`;

        return template
            .replace('{summary}', summary || '')
            .replace('{history}', history || '')
            .replace('{text}', text);
    };

    // Build the final prompt for base models
    // Variables: {history}, {text}
    const buildBasePrompt = (text, history) => {
        const p = getPersona();
        const template = `[${p.name} gives a quick, friendly one-liner]

{history}${p.userLabel}: {text}
${p.name}:`;

        return template
            .replace('{history}', history || '')
            .replace('{text}', text);
    };

    return {
        PERSONA,  // For backwards compat (snapshot at load time)
        getPersona,  // Dynamic getter
        get REALTIME_INSTRUCTIONS() { return getRealtimeInstructions(); },
        buildInstructPrompt,
        buildBasePrompt
    };
})();
