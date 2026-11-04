"""Jarvis'in internetsiz çok sesli Türkçe seslendirme sunucusu (Coqui XTTS-v2, coqui-tts paketi).

Jarvis (server/src/xtts.ts) bunu kendi sanal ortamında çalıştırır; yalnız 127.0.0.1'i dinler.
  GET  /health    -> {"ok": true, "cihaz": "cpu"|"cuda"}
  GET  /speakers  -> {"hazir": [...], "kendi": [...]}   (hazır stüdyo sesleri + kullanıcının eklediği kendi sesleri)
  POST /tts       -> WAV   gövde: {"text": "...", "voice": "Damien Black" | "kendi:Ramazan", "speed": 1.0}
Model ilk açılışta indirilir (~1,8 GB). Lisans (Coqui Public Model License) kullanıcı Jarvis'in onay kartında kabul edince
Jarvis COQUI_TOS_AGREED=1 ile başlatır.
"""
import argparse
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=3911)
ap.add_argument("--voices", required=True, help="kendi ses örneklerinin (wav) klasörü")
args = ap.parse_args()

import torch  # noqa: E402
from TTS.api import TTS  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(DEVICE)
LOCK = threading.Lock()


def builtin_speakers():
    try:
        return sorted(tts.speakers or [])
    except Exception:  # noqa: BLE001
        return []


def own_voices():
    os.makedirs(args.voices, exist_ok=True)
    return sorted(f[:-4] for f in os.listdir(args.voices) if f.lower().endswith(".wav"))


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # sessiz
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "cihaz": DEVICE})
        if self.path == "/speakers":
            return self._json(200, {"hazir": builtin_speakers(), "kendi": own_voices()})
        return self._json(404, {"error": "yok"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "yok"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            text = str(req.get("text", "")).strip()[:2000]
            voice = str(req.get("voice", "")).strip()
            speed = max(0.8, min(1.3, float(req.get("speed", 1.0))))
            if not text:
                return self._json(400, {"error": "metin boş"})
            kw = {"language": "tr", "speed": speed}
            if voice.startswith("kendi:"):
                name = os.path.basename(voice[6:])
                ref = os.path.join(args.voices, name + ".wav")
                if not os.path.exists(ref):
                    return self._json(404, {"error": f"kendi ses örneği yok: {name}"})
                kw["speaker_wav"] = ref
            else:
                kw["speaker"] = voice or (builtin_speakers() or [None])[0]
            fd, out = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            try:
                with LOCK:
                    tts.tts_to_file(text=text, file_path=out, **kw)
                with open(out, "rb") as f:
                    data = f.read()
            finally:
                os.remove(out)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": str(e)[:300]})


print(f"[xtts] hazır · {DEVICE} · port {args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
