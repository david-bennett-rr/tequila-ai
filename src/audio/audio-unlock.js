// AudioUnlock Module - iOS/Safari audio autoplay unlock
// Must be loaded before any audio modules that play sound.
//
// iOS Safari blocks all audio playback (Audio.play(), AudioContext) until a user
// gesture (tap/click) has initiated audio at least once. Desktop browsers do not
// have this restriction, which is why the app works on Windows/Mac but not iOS.
//
// This module listens for the first user gesture and uses it to:
//   1. Create and resume a shared AudioContext
//   2. Play a silent buffer through it (satisfies the iOS autoplay gate)
// Once unlocked, subsequent Audio.play() and AudioContext operations work without
// requiring additional gestures for the lifetime of the page.
//
// Uses: nothing (standalone, load early)
const AudioUnlock = (function() {
    let sharedContext = null;
    let unlocked = false;
    let unlockResolvers = [];

    // Get (or create) the shared AudioContext.
    // Other modules should call this instead of creating their own playback context.
    const getAudioContext = () => {
        if (!sharedContext || sharedContext.state === 'closed') {
            sharedContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        return sharedContext;
    };

    // Play a 1-sample silent buffer - this is the trick that satisfies iOS.
    const playSilentBuffer = (ctx) => {
        try {
            const buffer = ctx.createBuffer(1, 1, 22050);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start(0);
        } catch (e) {
            // Best effort - some very old WebKit versions may fail here
        }
    };

    // Core unlock - MUST run synchronously inside a user gesture handler.
    const unlock = () => {
        if (unlocked) return;

        const ctx = getAudioContext();

        // Play silent buffer to satisfy iOS autoplay policy
        playSilentBuffer(ctx);

        // Resume context - calling this within the gesture call-stack is what
        // iOS requires; the returned promise resolves asynchronously but the
        // intent is registered synchronously.
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        unlocked = true;

        // Resolve any code waiting for unlock
        unlockResolvers.forEach(r => r());
        unlockResolvers = [];

        console.log("[audio-unlock] audio unlocked, context state:", ctx.state);
    };

    // Re-ensure the shared context is running.
    // Call this after iOS may have suspended audio (e.g. page visibility change,
    // phone call interruption). Safe to call on desktop (no-op if already running).
    const ensureRunning = async () => {
        if (!sharedContext) return;
        if (sharedContext.state === 'suspended') {
            try {
                await sharedContext.resume();
            } catch (e) {
                // Will fail if no recent user gesture - caller should retry on next gesture
            }
        }
    };

    // Returns a promise that resolves once audio has been unlocked.
    const waitForUnlock = () => {
        if (unlocked) return Promise.resolve();
        return new Promise(resolve => unlockResolvers.push(resolve));
    };

    // Attach gesture listeners. Uses capture phase so we unlock BEFORE any
    // button handler fires (e.g. Connect button), ensuring the AudioContext is
    // running by the time WebRTC or TTS code executes.
    const init = () => {
        const gestureEvents = ['touchend', 'click', 'keydown'];

        const handler = () => {
            unlock();
            // Remove after first successful unlock - job done
            gestureEvents.forEach(evt =>
                document.removeEventListener(evt, handler, true)
            );
        };

        gestureEvents.forEach(evt =>
            document.addEventListener(evt, handler, { capture: true })
        );
    };

    return {
        init,
        getAudioContext,
        ensureRunning,
        waitForUnlock,
        get unlocked() { return unlocked; }
    };
})();
