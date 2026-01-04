# Tequila AI - Voice Assistant

Browser-based voice assistant for Jose Cuervo tequila information. Supports both cloud (OpenAI, ElevenLabs) and fully offline (Ollama, Piper/Coqui) operation.

## Prerequisites

- macOS (M1/M2) or Windows
- Modern browser (Chrome, Safari, Edge)
- Node.js - [nodejs.org](https://nodejs.org/) (LTS version)
- Python 3 - [python.org](https://www.python.org/downloads/)

---

## Windows Setup

### 1. Install Ollama
Download from [ollama.com/download](https://ollama.com/download).

```cmd
ollama pull llama2
set OLLAMA_ORIGINS=*
ollama serve
```

### 2. Install Piper TTS
1. Download Piper for Windows from [Piper releases](https://github.com/rhasspy/piper/releases)
2. Download a voice model (e.g., `en_US-lessac-high.onnx` + `.json`) from [Piper voices](https://github.com/rhasspy/piper/releases/tag/v1.2.0)
3. Extract both to `tequila-ai/piper/` folder
4. Start:
```cmd
cd tequila-ai\piper
node ..\tts-server.js --engine piper --model en_US-lessac-high.onnx
```
Note: Run from inside the `piper` folder so it can find the model and executable.

### 3. Serve the App
```cmd
cd tequila-ai
python -m http.server 8080
```

Open: `http://localhost:8080/tequila-ai.html`

### 4. Configure
In Settings:
- LLM Provider: **Local LLM**
- TTS Provider: **Local TTS (Piper/Coqui)**
- Engine: **Piper**
- Save

---

## macOS (M1/M2) Setup

### 1. Install Ollama
Download from [ollama.com/download](https://ollama.com/download).

```bash
ollama pull llama2
OLLAMA_ORIGINS="*" ollama serve
```

### 2. Install TTS (Piper or Coqui)

**Option A: Piper (fast, robotic)**
1. Download Piper for macOS from [Piper releases](https://github.com/rhasspy/piper/releases)
2. Download a voice model from [Piper voices](https://github.com/rhasspy/piper/releases/tag/v1.2.0)
3. Extract both to `tequila-ai/piper/` folder
4. Start:
```bash
cd tequila-ai/piper
chmod +x ./piper
node ../tts-server.js --engine piper --model en_US-lessac-high.onnx
```
Note: Run from inside the `piper` folder so it can find the model and executable.

Better Piper voice options:
- `en_US-lessac-high.onnx` - Default, clear
- `en_US-libritts_r-medium.onnx` - More natural
- `en_GB-semaine-medium.onnx` - British, clearer

**Option B: Coqui TTS (better quality, slower)**
```bash
pip install TTS
node tts-server.js --engine coqui
```

Coqui model options (pass via `--coqui-model`):
- `tts_models/en/vctk/vits` - Default, good quality, ~1-2 sec (English only)
- `tts_models/en/ljspeech/tacotron2-DDC` - Faster, decent quality (English only)
- `tts_models/multilingual/multi-dataset/xtts_v2` - Best quality, bilingual EN/ES, ~3-8 sec (recommended for demo)

Example with XTTS for Spanish support:
```bash
node tts-server.js --engine coqui --coqui-model tts_models/multilingual/multi-dataset/xtts_v2
```

### 3. Serve the App
```bash
cd tequila-ai
python3 -m http.server 8080
```

Open: `http://localhost:8080/tequila-ai.html`

### 4. Configure
In Settings:
- LLM Provider: **Local LLM**
- TTS Provider: **Local TTS (Piper/Coqui)**
- Engine: **Piper** or **Coqui**
- Save

---

## Cloud Setup (Optional)

For cloud operation, select OpenAI/ElevenLabs in settings and enter API keys. Requires internet.

---

## Kiosk Deployment Checklist

- [ ] Ollama installed and model pulled
- [ ] TTS server running (`tts-server.js`)
- [ ] `ollama serve` running with CORS enabled
- [ ] App served via HTTP (not file://)
- [ ] Browser in kiosk/fullscreen mode
- [ ] Auto-start scripts for Ollama + TTS on boot

---

## Troubleshooting

- **"Failed to fetch"**: Check Ollama/TTS server are running, CORS enabled
- **No audio**: Verify tts-server.js is running, check browser console
- **Slow responses**: Use smaller LLM model, or switch from Coqui to Piper
- **Voice quality**: Piper is fast but synthetic; Coqui XTTS sounds better but slower

---

## Credits

- [Ollama](https://ollama.com) - Local LLM
- [Piper TTS](https://github.com/rhasspy/piper) - Fast local speech synthesis
- [Coqui TTS](https://github.com/coqui-ai/TTS) - High quality local speech synthesis
- [OpenAI](https://platform.openai.com) / [ElevenLabs](https://elevenlabs.io) - Cloud APIs
