"""
kaira_voice.py — Módulo de voz para KAIra usando ElevenLabs
"""

import os
import threading
from dotenv import load_dotenv

load_dotenv()

try:
    from elevenlabs.client import ElevenLabs
    _VOICE_AVAILABLE = True
except ImportError:
    _VOICE_AVAILABLE = False
    print("[KAIra Voice] ElevenLabs no instalado — continuando sin voz")

VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
API_KEY  = os.getenv("ELEVENLABS_API_KEY", "")

_client = None

def _get_client():
    global _client
    if _client is None and _VOICE_AVAILABLE and API_KEY:
        _client = ElevenLabs(api_key=API_KEY)
    return _client


def _speak_async(text: str):
    try:
        client = _get_client()
        if client is None:
            return

        # Genera audio como bytes
        audio_generator = client.text_to_speech.convert(
            voice_id=VOICE_ID,
            text=text,
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )

        # Junta todos los chunks en bytes
        audio_bytes = b"".join(audio_generator)

        # Reproduce con pygame
        import pygame
        import io
        pygame.mixer.init()
        sound = pygame.mixer.Sound(io.BytesIO(audio_bytes))
        sound.play()

        # Espera a que termine
        while pygame.mixer.get_busy():
            pygame.time.wait(100)

    except Exception as e:
        print(f"[KAIra Voice] Error: {e}")


def speak(text: str, block: bool = False):
    if not _VOICE_AVAILABLE or not API_KEY:
        print(f"[KAIra Voice] {text}")
        return

    print(f"[KAIra Voice] 🔊 {text}")

    if block:
        _speak_async(text)
    else:
        t = threading.Thread(target=_speak_async, args=(text,), daemon=True)
        t.start()


# ── Frases con personalidad ───────────────────────────────────────────────────

def saludo_inicio(workflow_name: str, n_mappings: int):
    speak(
        f"Hola, soy KAIra. Aprendí el flujo {workflow_name} con {n_mappings} campos mapeados. "
        f"Comenzando la transferencia automática."
    )

def anunciar_mapeos(mappings: list):
    if not mappings:
        return
    resumen = ", ".join(
        f"{m.get('originLabel', '?')} a {m.get('destinationLabel', '?')}"
        for m in mappings[:5]
    )
    speak(
        f"Los campos que aprendí a transferir son: {resumen}. "
        f"Esto lo inferí por observación, no por programación directa."
    )

def inicio_turno(turn: int, max_turns: int):
    if turn == 1:
        speak("Analizando la pantalla e iniciando sesión.")
    elif turn == 3:
        speak("Accediendo a las órdenes pendientes.")
    elif turn == 6:
        speak("Transfiriendo datos al sistema interno de Arco.")

def accion_ejecutada(fname: str, args: dict):
    if fname == "navigate":
        url = args.get("url", "")
        if "login" in url:
            speak("Iniciando sesión en el sistema.")
        elif "orders" in url or "pedidos" in url:
            speak("Navegando a la lista de órdenes.")
        elif "nuevo" in url or "new" in url:
            speak("Abriendo formulario de nuevo pedido.")
    elif fname == "type_text_at":
        text = str(args.get("text", ""))
        if len(text) > 2 and not any(c in text for c in ["@", "12345"]):
            speak(f"Ingresando {text}.")

def error_accion(fname: str, error: str):
    speak(f"Tuve un problema al ejecutar {fname}. Continuando con el siguiente paso.")

def agente_termino():
    speak("He completado todas las acciones. El agente KAIra ha terminado su tarea.")