import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from google import genai
from google.genai import types

# ── Importa el módulo de voz de KAIra ────────────────────────────────────────
try:
    import kaira_voice as voice
    VOICE_ENABLED = True
except ImportError:
    VOICE_ENABLED = False
    print("[KAIra] Módulo de voz no encontrado — continuando sin voz")

load_dotenv()

WORKFLOW_FILE = Path(__file__).parent / "workflow.json"
SCREEN_WIDTH  = 1440
SCREEN_HEIGHT = 900
MAX_TURNS     = 30
MODEL         = "gemini-2.5-computer-use-preview-10-2025"


def denorm(coord, size):
    return int(coord / 1000 * size)


def execute_action(page, fname, args):
    label = f"{fname}({dict(args)})"
    print(f"  > {label}")

    # Narra la acción si la voz está activa
    if VOICE_ENABLED:
        voice.accion_ejecutada(fname, dict(args))

    try:
        if fname == "open_web_browser":
            pass

        elif fname == "navigate":
            page.goto(args["url"], wait_until="domcontentloaded", timeout=30000)

        elif fname == "click_at":
            page.mouse.click(denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT))

        elif fname == "hover_at":
            page.mouse.move(denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT))

        elif fname == "type_text_at":
            x = denorm(args["x"], SCREEN_WIDTH)
            y = denorm(args["y"], SCREEN_HEIGHT)
            page.mouse.click(x, y)
            if args.get("clear_before_typing", True):
                page.keyboard.press("Meta+A")
                page.keyboard.press("Backspace")
            page.keyboard.type(str(args.get("text", "")))
            if args.get("press_enter", False):
                page.keyboard.press("Enter")

        elif fname == "key_combination":
            page.keyboard.press(args["keys"])

        elif fname == "scroll_document":
            direction = args.get("direction", "down")
            page.keyboard.press("PageDown" if direction == "down" else "PageUp")

        elif fname == "scroll_at":
            x = denorm(args["x"], SCREEN_WIDTH)
            y = denorm(args["y"], SCREEN_HEIGHT)
            magnitude  = args.get("magnitude", 300)
            direction  = args.get("direction", "down")
            delta_y    = magnitude if direction == "down" else -magnitude
            page.mouse.wheel(x, y, delta_x=0, delta_y=delta_y)

        elif fname == "drag_and_drop":
            page.mouse.move(denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT))
            page.mouse.down()
            page.mouse.move(denorm(args["destination_x"], SCREEN_WIDTH), denorm(args["destination_y"], SCREEN_HEIGHT))
            page.mouse.up()

        elif fname == "go_back":
            page.go_back()

        elif fname == "go_forward":
            page.go_forward()

        elif fname == "wait_5_seconds":
            time.sleep(5)
            return

        elif fname == "search":
            page.goto("https://www.google.com", wait_until="domcontentloaded")

        else:
            print(f"    (unimplemented: {fname}, skipping)")

    except Exception as e:
        print(f"    x Error: {e}")
        # Narra el error
        if VOICE_ENABLED:
            voice.error_accion(fname, str(e))

    time.sleep(0.4)


def capture_state(page):
    try:
        page.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    time.sleep(0.8)
    return page.screenshot(type="png"), page.url


def main():
    workflow          = json.loads(WORKFLOW_FILE.read_text())
    task_description  = workflow.get("taskDescription", "")
    origin_url        = workflow.get("originUrl", "")
    field_mappings    = workflow.get("fieldMappings", "")
    mappings_list     = workflow.get("mappings", [])
    workflow_name     = workflow.get("workflowName", "transferencia")

    if not task_description:
        print("ERROR: workflow.json has no taskDescription. Run Stop + Learn first.")
        return

    print(f"\n{'='*60}")
    print(f"Workflow: {workflow_name}")
    print(f"Learned by: {workflow.get('learnedBy', '?')}")
    print(f"Task: {task_description[:120]}...")
    print(f"{'='*60}\n")

    # ── Saludo inicial con personalidad ──────────────────────────────────────
    if VOICE_ENABLED:
        voice.saludo_inicio(workflow_name, len(mappings_list))
        time.sleep(2)  # deja que termine de hablar antes de abrir el browser
        voice.anunciar_mapeos(mappings_list)
        time.sleep(3)

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    config = types.GenerateContentConfig(
        tools=[
            types.Tool(
                computer_use=types.ComputerUse(
                    environment=types.Environment.ENVIRONMENT_BROWSER
                )
            )
        ],
    )

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, slow_mo=250)
        context = browser.new_context(
            viewport={"width": SCREEN_WIDTH, "height": SCREEN_HEIGHT}
        )
        page = context.new_page()

        start_url = origin_url or workflow.get("destinationUrl", "about:blank")
        print(f"Opening: {start_url}")
        page.goto(start_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(1.5)

        initial_screenshot, current_url = capture_state(page)

        full_prompt = f"""{task_description}

Field mapping reference (from recorded example): {field_mappings}

Important rules:
- Complete the task fully and autonomously.
- If you need to navigate between pages, do so.
- Skip any order/item that already exists in the destination.
- When done with all items, stop and summarize what you did."""

        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part(text=full_prompt),
                    types.Part.from_bytes(data=initial_screenshot, mime_type="image/png"),
                ],
            )
        ]

        turns_completed = 0

        for turn in range(MAX_TURNS):
            print(f"\n--- Turn {turn + 1}/{MAX_TURNS} ---")

            # Narra turnos clave
            if VOICE_ENABLED:
                voice.inicio_turno(turn + 1, MAX_TURNS)

            response = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config=config,
            )

            candidate = response.candidates[0]
            contents.append(candidate.content)

            for part in candidate.content.parts:
                if hasattr(part, "text") and part.text:
                    print(f"  Gemini: {part.text[:200]}")

            function_calls = [
                p.function_call
                for p in candidate.content.parts
                if hasattr(p, "function_call") and p.function_call
            ]

            if not function_calls:
                print("\nOk Agent finished — no more actions.")
                turns_completed = turn + 1
                break

            results = []
            for fc in function_calls:
                execute_action(page, fc.name, dict(fc.args))
                results.append(fc.name)

            new_screenshot, new_url = capture_state(page)
            print(f"  URL: {new_url}")

            response_parts = []
            for name in results:
                response_parts.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=name,
                            response={"url": new_url},
                        )
                    )
                )

            response_parts.append(
                types.Part.from_bytes(data=new_screenshot, mime_type="image/png")
            )

            contents.append(types.Content(role="user", parts=response_parts))

        # ── Mensaje final ─────────────────────────────────────────────────────
        if VOICE_ENABLED:
            voice.agente_termino()

        print("\nAgent execution complete.")
        time.sleep(5)
        browser.close()


if __name__ == "__main__":
    main()