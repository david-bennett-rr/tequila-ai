const TTSProvider = (function() {
    let elevenLabsAudio = null;

    const speakWithElevenLabs = async (text) => {
        const apiKey = Storage.elevenLabsKey.trim();
        const voiceId = Storage.elevenLabsVoice.trim() || "21m00Tcm4TlvDq8ikWAM";
        
        if (!apiKey) {
            UI.log("[elevenlabs] missing API key");
            return;
        }

        try {
            UI.log("[elevenlabs] requesting audio...");
            Speech.setAssistantSpeaking(true);

            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_monolingual_v1",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    }
                })
            });

            if (!response.ok) {
                UI.log("[elevenlabs] error: " + (await response.text()));
                Speech.setAssistantSpeaking(false);
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            
            if (!elevenLabsAudio) {
                elevenLabsAudio = new Audio();
            }
            
            elevenLabsAudio.src = audioUrl;
            elevenLabsAudio.onended = () => {
                Speech.setAssistantSpeaking(false);
                URL.revokeObjectURL(audioUrl);
                UI.log("[elevenlabs] playback complete");
            };
            
            await elevenLabsAudio.play();
            UI.log("[elevenlabs] playing audio");
        } catch (e) {
            UI.log("[elevenlabs] error: " + e.message);
            Speech.setAssistantSpeaking(false);
        }
    };

    const stop = () => {
        if (elevenLabsAudio) {
            elevenLabsAudio.pause();
            elevenLabsAudio = null;
        }
    };

    const getProvider = () => {
        return Utils.$("ttsProvider")?.value || "openai";
    };

    const shouldUseSpeech = () => {
        const el = Utils.$("useSpeech");
        return el ? el.checked : true;
    };

    const shouldUseOpenAIAudio = () => {
        return shouldUseSpeech() && getProvider() === "openai";
    };

    return {
        speakWithElevenLabs,
        stop,
        getProvider,
        shouldUseSpeech,
        shouldUseOpenAIAudio
    };
})();