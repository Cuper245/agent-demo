import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from google import genai
from google.genai import types

load_dotenv()

WORKFLOW_FILE = Path(__file__).parent / "workflow.json"
SCREEN_WIDTH = 1440
SCREEN_HEIGHT = 900
MAX_TURNS = 30
MODEL = "gemini-2.5-computer-use-preview-10-2025"


def denorm(coord, size):
    return int(coord / 1000 * size)


def same_host(url_a, url_b):
    """Check if two URLs share the same hostname."""
    try:
        return urlparse(url_a).netloc == urlparse(url_b).netloc
    except Exception:
        return False


def find_tab_for_url(url, tabs):
    """Return the tab whose base URL matches the given URL, or None."""
    for tab_url, page in tabs.items():
        if same_host(url, tab_url):
            return page
    return None


def execute_action(fname, args, state):
    """
    Execute a Computer Use action.
    state = {"active": page, "tabs": {url: page, ...}}
    May switch state["active"] when navigate targets another open tab.
    """
    page = state["active"]
    label = f"{fname}({dict(args)})"
    print(f"  → {label}")

    try:
        if fname == "open_web_browser":
            pass

        elif fname == "navigate":
            target_url = args["url"]
            # Check if this URL belongs to an already-open tab
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
            magnitude = args.get("magnitude", 300)
            direction = args.get("direction", "down")
            page.mouse.wheel(x, y, delta_x=0, delta_y=magnitude if direction == "down" else -magnitude)

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
        print(f"    ✗ Error: {e}")

    time.sleep(0.4)


def capture_state(state):
    page = state["active"]
    try:
        page.wait_for_load_state("domcontentloaded", timeout=8000)
    except Exception:
        pass
    time.sleep(0.8)
    return page.screenshot(type="png"), page.url


def main():
    workflow = json.loads(WORKFLOW_FILE.read_text())
    task_description = workflow.get("taskDescription", "")
    origin_url = workflow.get("originUrl", "")
    destination_url = workflow.get("destinationUrl", "")
    field_mappings = workflow.get("fieldMappings", "")

    if not task_description:
        print("ERROR: workflow.json has no taskDescription. Run Stop + Learn first.")
        return

    print(f"\n{'='*60}")
    print(f"Workflow: {workflow.get('workflowName', 'unknown')}")
    print(f"Learned by: {workflow.get('learnedBy', '?')}")
    print(f"Task: {task_description[:120]}...")
    print(f"{'='*60}\n")

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

        # --- Open tabs ---
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

        # Start on first tab (origin, or destination if no origin)
        first_page = tabs.get(origin_url) or list(tabs.values())[0]
        first_page.bring_to_front()
        time.sleep(1.5)

        state = {"active": first_page, "tabs": tabs}

        # --- Build prompt ---
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

To switch between tabs, use the 'navigate' action with the target URL — the agent will bring the correct tab to the front automatically.

Field mapping reference (from recorded example): {field_mappings}

--- MANDATORY DEDUPLICATION PROTOCOL ---
You MUST follow these steps in order. Do not skip any step.

STEP 1 — Scan existing destination records:
  Navigate to the destination tab ({destination_url}).
  Scroll through ALL registered/existing records and read every ID (order number, PO, or equivalent).
  Mentally note the full list of IDs already present.

STEP 2 — Scan origin records:
  Navigate to the origin tab ({origin_url}).
  Scroll through ALL records and note every ID available.

STEP 3 — Calculate what is missing:
  Compare both lists.
  Only records that exist in the ORIGIN but NOT in the DESTINATION need to be transferred.
  If all records already exist in the destination, output a summary and stop — do not re-add anything.

STEP 4 — Transfer only the missing records:
  For each missing record (and only those), fill the destination form and submit.
  After each submission, verify the new record appears in the destination list before continuing.

STEP 5 — Final validation:
  After all transfers, go back to the destination and confirm every record from the origin now exists there.
  Report: how many already existed, how many were added, and list their IDs.
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

        # --- Agent loop ---
        for turn in range(MAX_TURNS):
            print(f"\n--- Turn {turn + 1}/{MAX_TURNS} | active tab: {state['active'].url} ---")

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
                print("\n✓ Agent finished — no more actions.")
                break

            executed = []
            for fc in function_calls:
                execute_action(fc.name, dict(fc.args), state)
                executed.append(fc.name)

            new_screenshot, new_url = capture_state(state)
            print(f"  Current URL: {new_url}")

            response_parts = []
            for name in executed:
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

        print("\nAgent execution complete. Browser will stay open — close it manually when done.")

        # Keep the process alive until the user closes the browser window
        try:
            first_page.wait_for_event("close", timeout=0)
        except Exception:
            pass


if __name__ == "__main__":
    main()
