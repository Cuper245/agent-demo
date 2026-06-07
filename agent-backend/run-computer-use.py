import json
import os
import time
import base64
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

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
LOGS_DIR = Path(__file__).parent / "logs"
SCREEN_WIDTH = 1440
SCREEN_HEIGHT = 900
MAX_TURNS = 50
MODEL = "gemini-2.5-computer-use-preview-10-2025"


# ─── Logging ──────────────────────────────────────────────────────────────────

class RunLogger:
    def __init__(self, workflow: dict):
        self.run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.run_dir = LOGS_DIR / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=True)

        self.log = {
            "runId": self.run_id,
            "startedAt": datetime.now().isoformat(),
            "workflow": {
                "name": workflow.get("workflowName"),
                "type": workflow.get("workflowType"),
                "learnedBy": workflow.get("learnedBy"),
                "originUrl": workflow.get("originUrl"),
                "destinationUrl": workflow.get("destinationUrl"),
            },
            "turns": [],
            "completedAt": None,
            "summary": None,
        }
        print(f"  📁 Log: logs/{self.run_id}/")

    def save_screenshot(self, screenshot_bytes: bytes, turn: int) -> str:
        filename = f"turn-{turn:03d}.png"
        (self.run_dir / filename).write_bytes(screenshot_bytes)
        return filename

    def add_turn(self, turn: int, active_url: str, reasoning: str,
                 actions: list, screenshot_bytes: bytes, url_after: str):
        screenshot_file = self.save_screenshot(screenshot_bytes, turn)
        entry = {
            "turn": turn,
            "timestamp": datetime.now().isoformat(),
            "activeUrl": active_url,
            "geminireasoning": reasoning,
            "actions": actions,
            "screenshotFile": screenshot_file,
            "urlAfter": url_after,
        }
        self.log["turns"].append(entry)
        self._flush()

    def finish(self, summary: str):
        self.log["completedAt"] = datetime.now().isoformat()
        self.log["summary"] = summary
        self._flush()
        print(f"\n  📋 Full log saved: logs/{self.run_id}/run.json")
        print(f"  🖼️  Screenshots: logs/{self.run_id}/turn-*.png")

    def _flush(self):
        (self.run_dir / "run.json").write_text(
            json.dumps(self.log, indent=2, ensure_ascii=False)
        )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def denorm(coord, size):
    return int(coord / 1000 * size)


def same_host(url_a, url_b):
    try:
        return urlparse(url_a).netloc == urlparse(url_b).netloc
    except Exception:
        return False


def find_tab_for_url(url, tabs):
    for tab_url, page in tabs.items():
        if same_host(url, tab_url):
            return page
    return None


# ─── Action executor ──────────────────────────────────────────────────────────

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
            target_url = args["url"]
            other_tab = find_tab_for_url(target_url, state["tabs"])
            if other_tab and other_tab is not page:
                print(f"    ↪ switching tab to {target_url}")
                other_tab.bring_to_front()
                state["active"] = other_tab
            else:
                page.goto(target_url, wait_until="domcontentloaded", timeout=30000)

        elif fname == "click_at":
            page.mouse.click(denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT))

        elif fname == "hover_at":
            page.mouse.move(denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT))

        elif fname == "type_text_at":
            x, y = denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT)
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
<<<<<<< HEAD
            x, y = denorm(args["x"], SCREEN_WIDTH), denorm(args["y"], SCREEN_HEIGHT)
            magnitude = args.get("magnitude", 300)
            direction = args.get("direction", "down")
            page.mouse.wheel(x, y, delta_x=0, delta_y=magnitude if direction == "down" else -magnitude)
=======
            x = denorm(args["x"], SCREEN_WIDTH)
            y = denorm(args["y"], SCREEN_HEIGHT)
            magnitude  = args.get("magnitude", 300)
            direction  = args.get("direction", "down")
            delta_y    = magnitude if direction == "down" else -magnitude
            page.mouse.wheel(x, y, delta_x=0, delta_y=delta_y)
>>>>>>> ana

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

    time.sleep(0.2)   # reduced from 0.4


def capture_state(state):
    page = state["active"]
    try:
        page.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    time.sleep(0.4)   # reduced from 0.8
    return page.screenshot(type="png"), page.url


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    workflow = json.loads(WORKFLOW_FILE.read_text())
    task_description = workflow.get("taskDescription", "")
    origin_url = workflow.get("originUrl", "")
    destination_url = workflow.get("destinationUrl", "")
    field_mappings = workflow.get("fieldMappings", "")

    if not task_description:
        print("ERROR: workflow.json has no taskDescription. Run Stop + Learn first.")
        return

    logger = RunLogger(workflow)

    print(f"\n{'='*60}")
    print(f"Workflow : {workflow.get('workflowName', 'unknown')}")
    print(f"Learned  : {workflow.get('learnedBy', '?')}")
    print(f"Task     : {task_description[:120]}...")
    print(f"{'='*60}\n")

    # ── Saludo inicial con personalidad ──────────────────────────────────────
    if VOICE_ENABLED:
        voice.saludo_inicio(workflow_name, len(mappings_list))
        time.sleep(2)  # deja que termine de hablar antes de abrir el browser
        voice.anunciar_mapeos(mappings_list)
        time.sleep(3)

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    config = types.GenerateContentConfig(
        tools=[types.Tool(computer_use=types.ComputerUse(
            environment=types.Environment.ENVIRONMENT_BROWSER
        ))],
    )

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, slow_mo=100)   # reduced from 250
        context = browser.new_context(
            viewport={"width": SCREEN_WIDTH, "height": SCREEN_HEIGHT}
        )

        # ── Open tabs ──────────────────────────────────────────────
        tabs = {}
        if origin_url:
            print(f"Opening tab 1 (origin): {origin_url}")
            p1 = context.new_page()
            p1.goto(origin_url, wait_until="domcontentloaded", timeout=30000)
            tabs[origin_url] = p1

        if destination_url and destination_url != origin_url:
            print(f"Opening tab 2 (destination): {destination_url}")
            p2 = context.new_page()
            p2.goto(destination_url, wait_until="domcontentloaded", timeout=30000)
            tabs[destination_url] = p2

        if not tabs:
            print("ERROR: no URLs in workflow.json")
            return

        first_page = tabs.get(origin_url) or list(tabs.values())[0]
        first_page.bring_to_front()
        time.sleep(1)

        state = {"active": first_page, "tabs": tabs}

        # ── Build prompt ────────────────────────────────────────────
        arco_email = os.environ.get("ARCO_EMAIL", "")
        arco_password = os.environ.get("ARCO_PASSWORD", "")
        creds_hint = ""
        if arco_email and arco_password:
            creds_hint = f"\nCredentials to use if login is required: email={arco_email}, password={arco_password}"

        tabs_description = "\n".join(
            [f"  - Tab {i+1}: {url}" for i, url in enumerate(tabs.keys())]
        )

        full_prompt = f"""{task_description}{creds_hint}

You have {len(tabs)} browser tab(s) open:
{tabs_description}

To switch between tabs, use the 'navigate' action with the target URL — the correct tab will come to front automatically.

Field mapping reference (from recorded example): {field_mappings}

--- CRITICAL RULES (read before doing anything) ---
1. NEVER stop in the middle of filling a form. If you started filling fields, you MUST click the save/submit/guardar button before stopping or switching tabs.
2. NEVER consider a record "transferred" until you have clicked the submit button AND confirmed the record appears in the destination list.
3. If you cannot find the submit button, scroll down — it may be below the visible area.
4. Only stop and report when ALL records have been fully processed and verified.

--- MANDATORY DEDUPLICATION PROTOCOL ---
Follow these steps in order. Do not skip any step.

STEP 1 — Scan existing destination records:
  Navigate to the destination tab ({destination_url}).
  Scroll through ALL registered/existing records and note every ID visible.
  If there are no records yet, note that the destination is empty.

STEP 2 — Scan origin records:
  Navigate to the origin tab ({origin_url}).
  Scroll through ALL records and note every ID available.

STEP 3 — Calculate what is missing:
  Compare both lists.
  Only records that exist in the ORIGIN but NOT in the DESTINATION need to be transferred.
  If all records already exist, output a summary and stop — do not re-add anything.

STEP 4 — Transfer only the missing records (one by one):
  For each missing record:
    a. Read ALL the fields for that record from the origin.
    b. Switch to the destination tab.
    c. Fill EVERY required field in the form — do not leave any field empty.
    d. Scroll down if needed to find remaining fields or the submit button.
    e. Click the save/submit/guardar button to save the record.
    f. Wait and confirm the new record now appears in the destination list.
    g. Only then move on to the next record.

STEP 5 — Final validation:
  After all transfers, go to the destination and verify every origin record is now present.
  Report: how many already existed, how many were added, list their IDs.
---"""

        initial_screenshot, current_url = capture_state(state)

        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part(text=full_prompt),
                    types.Part.from_bytes(data=initial_screenshot, mime_type="image/png"),
                ],
            )
        ]

        # ── Agent loop ──────────────────────────────────────────────
        final_summary = "Agent stopped without summary."

        for turn_num in range(1, MAX_TURNS + 1):
            active_url_before = state["active"].url
            print(f"\n--- Turn {turn_num}/{MAX_TURNS} | {active_url_before} ---")

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

            # Collect reasoning text
            reasoning_parts = []
            for part in candidate.content.parts:
                if hasattr(part, "text") and part.text:
                    reasoning_parts.append(part.text)
                    print(f"  Gemini: {part.text[:200]}")
            reasoning = " ".join(reasoning_parts)

<<<<<<< HEAD
            # Collect function calls
=======
>>>>>>> ana
            function_calls = [
                p.function_call
                for p in candidate.content.parts
                if hasattr(p, "function_call") and p.function_call
            ]

            if not function_calls:
<<<<<<< HEAD
                final_summary = reasoning or "No further actions."
                print("\n✓ Agent finished.")
                # Log final state
                final_screenshot, final_url = capture_state(state)
                logger.add_turn(
                    turn=turn_num,
                    active_url=active_url_before,
                    reasoning=reasoning,
                    actions=[],
                    screenshot_bytes=final_screenshot,
                    url_after=final_url,
                )
                break

            # Execute actions and log them
            executed_actions = []
=======
                print("\nOk Agent finished — no more actions.")
                turns_completed = turn + 1
                break

            results = []
>>>>>>> ana
            for fc in function_calls:
                action_entry = {"name": fc.name, "args": dict(fc.args)}
                execute_action(fc.name, dict(fc.args), state)
                executed_actions.append(action_entry)

<<<<<<< HEAD
            new_screenshot, new_url = capture_state(state)
            print(f"  URL after: {new_url}")

            logger.add_turn(
                turn=turn_num,
                active_url=active_url_before,
                reasoning=reasoning,
                actions=executed_actions,
                screenshot_bytes=new_screenshot,
                url_after=new_url,
            )

            # Build function responses
=======
            new_screenshot, new_url = capture_state(page)
            print(f"  URL: {new_url}")

>>>>>>> ana
            response_parts = []
            for fc in function_calls:
                response_parts.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=fc.name,
                            response={"url": new_url},
                        )
                    )
                )
<<<<<<< HEAD
=======

>>>>>>> ana
            response_parts.append(
                types.Part.from_bytes(data=new_screenshot, mime_type="image/png")
            )
            contents.append(types.Content(role="user", parts=response_parts))

<<<<<<< HEAD
        logger.finish(final_summary)
        print("\nAgent execution complete. Close the browser when done.")

        try:
            first_page.wait_for_event("close", timeout=0)
        except Exception:
            pass
=======
        # ── Mensaje final ─────────────────────────────────────────────────────
        if VOICE_ENABLED:
            voice.agente_termino()

        print("\nAgent execution complete.")
        time.sleep(5)
        browser.close()
>>>>>>> ana


if __name__ == "__main__":
    main()