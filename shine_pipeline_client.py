import os
import re
import base64
from pathlib import Path
import requests

# --- Config ---
ROUTER_API = os.getenv("ROUTER_API", "http://127.0.0.1:8787/generate")
STYLETTS2_URL = os.getenv("STYLETTS2_URL", "http://127.0.0.1:8899")
RVC_API_URL = os.getenv("RVC_API_URL", "http://127.0.0.1:5050")

RVC_MODEL_NAME = os.getenv("RVC_MODEL_NAME", "Kanna")
RVC_PITCH_UP = int(os.getenv("RVC_PITCH_UP", "2"))
EMBEDDING_SCALE = float(os.getenv("EMBEDDING_SCALE", "1.9"))
MODE = os.getenv("SHINE_MODE", "default")  # e.g. energetic_childlike

OUT_DIR = Path(os.getenv("OUT_DIR", r"E:\Shine Voice\out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)
TTS_WAV = OUT_DIR / "tts.wav"
FINAL_WAV = OUT_DIR / "final.wav"

_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\U00002600-\U000027BF"
    "]+",
    flags=re.UNICODE,
)

def strip_emojis(text: str) -> str:
    return _EMOJI_RE.sub("", text or "").strip()

def router_generate(user_text: str, conversation_id: str = "main") -> str:
    r = requests.post(ROUTER_API, json={"text": user_text, "conversationId": conversation_id, "mode": MODE}, timeout=180)
    r.raise_for_status()
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError(j)
    return strip_emojis(j.get("text",""))

def styletts2_tts(text: str, out_wav: Path):
    payload = {"text": text, "out": out_wav.as_posix(), "embedding_scale": EMBEDDING_SCALE}
    r = requests.post(STYLETTS2_URL, json=payload, timeout=600)
    r.raise_for_status()
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError(j)
    if not out_wav.exists():
        raise FileNotFoundError(out_wav)

def rvc_load_model(name: str):
    r = requests.post(f"{RVC_API_URL}/models/{name}", timeout=180)
    r.raise_for_status()

def rvc_set_params(pitch_up: int):
    params = {
        "f0method": "rmvpe",
        "f0up_key": pitch_up,
        "index_rate": 0.5,
        "filter_radius": 3,
        "resample_sr": 0,
        "rms_mix_rate": 0.25,
        "protect": 0.4,
    }
    r = requests.post(f"{RVC_API_URL}/params", json={"params": params}, timeout=180)
    r.raise_for_status()

def rvc_convert(in_wav: Path, out_wav: Path):
    audio_b64 = base64.b64encode(in_wav.read_bytes()).decode("utf-8")
    r = requests.post(f"{RVC_API_URL}/convert", json={"audio_data": audio_b64}, timeout=600)
    r.raise_for_status()
    out_wav.write_bytes(r.content)

if __name__ == "__main__":
    user = input("You: ").strip()
    if not user:
        raise SystemExit

    text = router_generate(user)
    print("\nShine:", text, "\n")

    styletts2_tts(text, TTS_WAV)
    rvc_load_model(RVC_MODEL_NAME)
    rvc_set_params(RVC_PITCH_UP)
    rvc_convert(TTS_WAV, FINAL_WAV)
    print("Wrote:", FINAL_WAV)
