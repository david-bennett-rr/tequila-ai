const AudioMonitor = (function() {
    let audioContext = null;
    let analyser = null;
    let source = null;
    let checkInterval = null;
    let silenceStartTime = 0;
    const SILENCE_THRESHOLD = 500;

    const setup = (stream) => {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            
            source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser);
            
            start();
            UI.log("[audio] analyser setup complete");
        } catch (e) {
            UI.log("[audio] analyser setup failed: " + e.message);
        }
    };

    const start = () => {
        if (checkInterval) return;
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let wasPlaying = false;
        
        checkInterval = setInterval(() => {
            if (!analyser) return;
            
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const isPlaying = average > 5;
            
            if (isPlaying && !wasPlaying) {
                wasPlaying = true;
                silenceStartTime = 0;
                if (!Speech.assistantSpeaking) {
                    Speech.setAssistantSpeaking(true);
                    UI.log("[audio] detected start (level: " + average.toFixed(1) + ")");
                }
            } else if (!isPlaying && wasPlaying) {
                if (silenceStartTime === 0) {
                    silenceStartTime = Date.now();
                }
                
                const silenceDuration = Date.now() - silenceStartTime;
                if (silenceDuration > SILENCE_THRESHOLD) {
                    wasPlaying = false;
                    silenceStartTime = 0;
                    if (Speech.assistantSpeaking) {
                        Speech.setAssistantSpeaking(false);
                        UI.log("[audio] detected end (silence: " + silenceDuration + "ms)");
                    }
                }
            }
        }, 50);
    };

    const stop = () => {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        if (source) {
            source.disconnect();
            source = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        analyser = null;
    };

    return { setup, stop };
})();