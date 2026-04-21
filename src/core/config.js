// Config Module - Centralized configuration constants
const Config = (function() {
    return {
        // Speech recognition
        SILENCE_THRESHOLD: 700,           // ms of silence before sending speech
        MIN_WORDS_FOR_SEND: 2,            // minimum words before considering send

        // Retry/backoff settings
        BASE_RETRY_DELAY: 500,            // initial retry delay (ms)
        MAX_RETRY_DELAY: 10000,           // max retry delay for speech (ms)
        BASE_RECONNECT_DELAY: 2000,       // initial WebRTC reconnect delay (ms)
        MAX_RECONNECT_DELAY: 30000,       // max WebRTC reconnect delay (ms)

        // Watchdog intervals
        WATCHDOG_INTERVAL: 5000,          // general watchdog check interval (ms)
        HEALTH_CHECK_INTERVAL: 10000,     // health check interval (ms)
        CONNECTION_MONITOR_INTERVAL: 5000, // WebRTC connection check interval (ms)
        BROWSER_TTS_WATCHDOG_INTERVAL: 500, // Chrome TTS bug check interval (ms)
        AUDIO_MONITOR_INTERVAL: 50,       // audio level check interval (ms)

        // Timeouts / max durations
        MAX_SPEAKING_DURATION: 60000,     // max TTS duration before force-stop (ms)
        MAX_AUDIO_SPEAKING_DURATION: 120000, // max audio monitor speaking duration (ms)
        AUDIO_SILENCE_THRESHOLD: 500,     // ms of audio silence before end-of-speech
        REALTIME_SESSION_MAX_DURATION: 60 * 60 * 1000, // OpenAI Realtime sessions currently max out at 60 minutes
        REALTIME_SESSION_RECONNECT_BUFFER: 60 * 1000,  // rotate the session 1 minute early to avoid hard expiry

        // Audio analysis
        AUDIO_LEVEL_THRESHOLD: 20,        // minimum average level to detect audio (higher = less sensitive)

        // Chrome TTS workaround
        CHROME_RESUME_INTERVAL: 10000,    // pause/resume interval for Chrome bug (ms)

        // Kiosk recovery
        MAX_RECONNECT_ATTEMPTS: Number.POSITIVE_INFINITY, // keep retrying while the app should stay connected
        MAX_SPEECH_RETRY_ATTEMPTS: 10,    // max speech recognition retries before page reload
        PAGE_RELOAD_DELAY: 5000,          // delay before page reload (ms)
    };
})();
