#!/usr/bin/env node
/**
 * Unified TTS server for Piper and Coqui.
 * Runs either engine directly - no separate server needed.
 *
 * Usage:
 *    node tts-server.js              # Uses defaults (piper + auto-detected model)
 *    node tts-server.js --help       # Show help
 *    node tts-server.js --port 5003  # Custom port
 *    node tts-server.js --engine coqui --coqui-model tts_models/en/vctk/vits
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Paths relative to this script
const SCRIPT_DIR = __dirname;
const PIPER_DIR = path.resolve(SCRIPT_DIR, '../../piper');
const DEFAULT_MODEL = 'en_US-john-medium.onnx';

function showHelp() {
    console.log(`
TTS Server - Piper & Coqui text-to-speech

Usage: node tts-server.js [options]

Options:
  --help              Show this help message
  --engine <name>     TTS engine: piper (default) or coqui
  --port <number>     Server port (default: 5002)
  --model <file>      Piper model file (default: ${DEFAULT_MODEL})
  --piper <path>      Path to piper executable
  --coqui-model <id>  Coqui model name (default: tts_models/en/vctk/vits)

Examples:
  node tts-server.js                          # Start with defaults
  node tts-server.js --port 5003              # Custom port
  node tts-server.js --engine coqui           # Use Coqui TTS

API:
  GET  /api/tts?text=Hello                    # Query param
  POST /api/tts  {"text": "Hello"}            # JSON body

Available Piper models in ${PIPER_DIR}:
`);
    // List available models
    if (fs.existsSync(PIPER_DIR)) {
        const models = fs.readdirSync(PIPER_DIR).filter(f => f.endsWith('.onnx'));
        if (models.length > 0) {
            models.forEach(m => console.log(`  - ${m}`));
        } else {
            console.log('  (no models found)');
        }
    } else {
        console.log('  (piper directory not found)');
    }
    console.log('');
    process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    showHelp();
}

let engine = 'piper';
let port = 5002;
let model = '';
let piperPath = '';
let coquiModel = 'tts_models/en/vctk/vits';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--engine' && args[i + 1]) {
        engine = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
        model = args[++i];
    } else if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[++i], 10);
    } else if (args[i] === '--piper' && args[i + 1]) {
        piperPath = args[++i];
    } else if (args[i] === '--coqui-model' && args[i + 1]) {
        coquiModel = args[++i];
    }
}

// Auto-detect piper executable and model if not specified
if (engine === 'piper') {
    if (!piperPath) {
        const defaultPiper = path.join(PIPER_DIR, process.platform === 'win32' ? 'piper.exe' : 'piper');
        if (fs.existsSync(defaultPiper)) {
            piperPath = defaultPiper;
        }
    }
    if (!model) {
        const defaultModel = path.join(PIPER_DIR, DEFAULT_MODEL);
        if (fs.existsSync(defaultModel)) {
            model = defaultModel;
        }
    }
}

// ============= Piper Mode =============
const piperQueue = [];
let piperProcessing = false;

function processPiperQueue() {
    if (piperProcessing || piperQueue.length === 0) return;

    piperProcessing = true;
    const { text, res } = piperQueue.shift();
    const startTime = Date.now();
    const tmpFile = path.join(os.tmpdir(), `piper_${Date.now()}.wav`);

    console.log(`[tts-server] Piper: "${text.substring(0, 50)}..."`);

    const piper = spawn(piperPath, ['--model', model, '--output_file', tmpFile], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    piper.stdin.write(text);
    piper.stdin.end();

    let stderr = '';
    piper.stderr.on('data', (data) => { stderr += data.toString(); });

    piper.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(tmpFile)) {
            console.error(`[tts-server] Piper failed: ${stderr}`);
            res.writeHead(500);
            res.end('Piper failed: ' + stderr);
            piperProcessing = false;
            processPiperQueue();
            return;
        }

        const wavData = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);

        res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wavData.length
        });
        res.end(wavData);

        console.log(`[tts-server] Piper: ${wavData.length} bytes in ${Date.now() - startTime}ms`);
        piperProcessing = false;
        processPiperQueue();
    });

    piper.on('error', (err) => {
        console.error(`[tts-server] Piper error: ${err.message}`);
        res.writeHead(500);
        res.end('Piper error: ' + err.message);
        piperProcessing = false;
        processPiperQueue();
    });
}

function handlePiperRequest(text, res) {
    piperQueue.push({ text, res });
    processPiperQueue();
}

// ============= Coqui Mode =============
const coquiQueue = [];
let coquiProcessing = false;

function processCoquiQueue() {
    if (coquiProcessing || coquiQueue.length === 0) return;

    coquiProcessing = true;
    const { text, res } = coquiQueue.shift();
    const startTime = Date.now();

    // Create temp file for output
    const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}.wav`);

    console.log(`[tts-server] Coqui: "${text.substring(0, 50)}..."`);

    // Run tts CLI directly
    const tts = spawn('tts', [
        '--model_name', coquiModel,
        '--text', text,
        '--out_path', tmpFile
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    tts.stderr.on('data', (data) => { stderr += data.toString(); });

    tts.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(tmpFile)) {
            console.error(`[tts-server] Coqui failed: ${stderr}`);
            res.writeHead(500);
            res.end('Coqui TTS failed: ' + stderr);
            coquiProcessing = false;
            processCoquiQueue();
            return;
        }

        const wavData = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);

        res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wavData.length
        });
        res.end(wavData);

        console.log(`[tts-server] Coqui: ${wavData.length} bytes in ${Date.now() - startTime}ms`);
        coquiProcessing = false;
        processCoquiQueue();
    });

    tts.on('error', (err) => {
        console.error(`[tts-server] Coqui spawn error: ${err.message}`);
        res.writeHead(500);
        res.end('Coqui not installed. Run: pip install TTS');
        coquiProcessing = false;
        processCoquiQueue();
    });
}

function handleCoquiRequest(text, res) {
    coquiQueue.push({ text, res });
    processCoquiQueue();
}

// ============= Main Server =============
if (engine === 'piper') {
    if (!model) {
        console.error('Error: No Piper model found.');
        console.error(`Expected model at: ${path.join(PIPER_DIR, DEFAULT_MODEL)}`);
        console.error('Run with --help for usage info.');
        process.exit(1);
    }
    if (!fs.existsSync(model)) {
        console.error(`Error: Model not found: ${model}`);
        process.exit(1);
    }
    if (!piperPath || !fs.existsSync(piperPath)) {
        console.error('Error: Piper executable not found.');
        console.error(`Expected at: ${path.join(PIPER_DIR, 'piper.exe')}`);
        process.exit(1);
    }
    console.log('[tts-server] Piper ready');
    console.log(`[tts-server] Model: ${path.basename(model)}`);
} else if (engine === 'coqui') {
    // Verify tts is installed
    try {
        execSync('tts --help', { stdio: 'pipe' });
        console.log('[tts-server] Coqui TTS found');
        console.log(`[tts-server] Model: ${coquiModel}`);
    } catch (e) {
        console.error('Coqui TTS not found. Install with: pip install TTS');
        process.exit(1);
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (!req.url.startsWith('/api/tts')) {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    // Handle both GET (with ?text=) and POST (with JSON body)
    if (req.method === 'GET') {
        const url = new URL(req.url, `http://localhost:${port}`);
        const text = url.searchParams.get('text');
        if (!text) {
            res.writeHead(400);
            res.end('Missing text parameter');
            return;
        }
        if (engine === 'coqui') {
            handleCoquiRequest(text, res);
        } else {
            handlePiperRequest(text, res);
        }
    } else if (req.method === 'POST') {
        const MAX_BODY_SIZE = 1024 * 1024;  // 1MB limit for POST body
        let body = '';
        let bodyTooLarge = false;

        req.on('data', chunk => {
            if (bodyTooLarge) return;  // Stop processing if already too large

            body += chunk.toString();

            // Check size limit
            if (body.length > MAX_BODY_SIZE) {
                bodyTooLarge = true;
                res.writeHead(413, { 'Content-Type': 'text/plain' });
                res.end('Request body too large (max 1MB)');
                req.destroy();  // Stop receiving more data
            }
        });

        req.on('end', () => {
            if (bodyTooLarge) return;  // Already handled

            let text;
            try {
                text = JSON.parse(body).text || '';
            } catch (e) {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
            }
            if (!text) {
                res.writeHead(400);
                res.end('Missing text');
                return;
            }
            if (engine === 'coqui') {
                handleCoquiRequest(text, res);
            } else {
                handlePiperRequest(text, res);
            }
        });
    } else {
        res.writeHead(405);
        res.end('Method not allowed');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[tts-server] Engine: ${engine.toUpperCase()}`);
    console.log(`[tts-server] http://localhost:${port}/api/tts`);
    console.log(`[tts-server] Ctrl+C to stop`);
});
