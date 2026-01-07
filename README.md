# Tequila AI - Voice Assistant

Browser-based voice assistant for Jose Cuervo tequila information. Supports cloud (OpenAI, ElevenLabs) and local (Ollama, Piper) operation.

## Prerequisites

- Windows or macOS
- Modern browser (Chrome, Safari, Edge)
- Node.js - [nodejs.org](https://nodejs.org/) (LTS version)
- Python 3 - [python.org](https://www.python.org/downloads/)

---

## Windows Setup

Piper TTS is pre-installed in the `piper/` folder with the `en_US-john-medium` voice model.

### 1. Install Ollama
Download from [ollama.com/download](https://ollama.com/download).

```cmd
ollama pull llama2
set OLLAMA_ORIGINS=*
ollama serve
```

### 2. Start Piper TTS
```cmd
cd tequila-ai\piper
node ..\tts-server.js --engine piper --model en_US-john-medium.onnx
```

### 3. Serve the App
```cmd
cd tequila-ai
python -m http.server 8080
```

Open: `http://localhost:8080/tequila-ai.html`

### 4. Configure
In Settings:
- LLM Provider: **Local LLM**
- TTS Provider: **Local TTS**
- Save

---

## macOS Setup

### 1. Install Ollama
Download from [ollama.com/download](https://ollama.com/download).

```bash
ollama pull llama2
OLLAMA_ORIGINS="*" ollama serve
```

### 2. Install Piper TTS
1. Download Piper for macOS from [Piper releases](https://github.com/rhasspy/piper/releases)
2. Download a voice model from [Piper voices](https://github.com/rhasspy/piper/releases/tag/v1.2.0)
3. Extract both to `tequila-ai/piper/` folder
4. Start:
```bash
cd tequila-ai/piper
chmod +x ./piper
node ../tts-server.js --engine piper --model <your-model>.onnx
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
- TTS Provider: **Local TTS**
- Save

---

## Cloud Setup (Optional)

For cloud operation, select OpenAI or ElevenLabs in settings and enter API keys. Requires internet.

---

## Troubleshooting

- **"Failed to fetch"**: Check Ollama/TTS server are running, CORS enabled
- **No audio**: Verify tts-server.js is running, check browser console
- **Slow responses**: Try a smaller Ollama model
- **Ollama port already in use** (Windows): Another Ollama process is holding the port. Find and kill it:
  ```cmd
  netstat -ano | findstr :11434
  taskkill /PID <PID_NUMBER> /F
  ```
  Or kill all Ollama processes at once:
  ```cmd
  taskkill /IM ollama.exe /F /T
  ```
