"""Run a focused mobile smoke test against a local catalog page.

This uses Edge headless over the Chrome DevTools Protocol so we can verify
mobile-only layout fixes without relying on a separate browser automation
service. The script captures screenshots and reports the key geometry checks
for the mobile filter drawer and the product modal close control.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
PORT = 9223
DEFAULT_URL = "http://127.0.0.1:4173/baseball-cards.html"
DEFAULT_OUT_DIR = Path(r"C:\Users\djwan\Downloads\djshouseofcards-next-fixes-applied\outputs\mobile-smoke")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test the mobile catalog modal and filter drawer.")
    parser.add_argument("--url", default=DEFAULT_URL, help="Catalog page URL to test.")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="Directory for captured screenshots.")
    return parser.parse_args()


def fetch_json(url: str, attempts: int = 80) -> dict | list:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response)
        except Exception as exc:  # pragma: no cover - smoke helper
            last_error = exc
            time.sleep(0.25)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


class CdpClient:
    def __init__(self, websocket_connection):
        self.websocket_connection = websocket_connection
        self.capture_directory = DEFAULT_OUT_DIR
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._events: dict[str, asyncio.Future] = {}
        self._recv_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _recv_loop(self) -> None:
        async for message in self.websocket_connection:
            payload = json.loads(message)
            if "id" in payload and payload["id"] in self._pending:
                future = self._pending.pop(payload["id"])
                if "error" in payload:
                    future.set_exception(RuntimeError(payload["error"].get("message", "CDP error")))
                else:
                    future.set_result(payload.get("result", {}))
                continue

            method = payload.get("method")
            if method and method in self._events and not self._events[method].done():
                self._events[method].set_result(payload.get("params", {}))

    async def send(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        message_id = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        await self.websocket_connection.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        try:
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self._pending.pop(message_id, None)

    async def once(self, method: str) -> dict:
        future = asyncio.get_running_loop().create_future()
        self._events[method] = future
        try:
            return await asyncio.wait_for(future, timeout=30)
        finally:
            if self._events.get(method) is future:
                self._events.pop(method, None)

    async def evaluate(self, expression: str):
        result = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            },
        )
        return result.get("result", {}).get("value")

    async def capture(self, name: str) -> str:
        result = await self.send("Page.captureScreenshot", {"format": "png"})
        out_path = self.capture_directory / name
        out_path.write_bytes(base64.b64decode(result["data"]))
        return str(out_path)


async def main() -> None:
    args = parse_args()
    out_dir = Path(args.out_dir)

    if not EDGE_PATH.exists():
        raise FileNotFoundError(f"Edge not found at {EDGE_PATH}")

    out_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = Path(tempfile.gettempdir()) / f"dj-edge-{int(time.time() * 1000)}"
    profile_dir.mkdir(parents=True, exist_ok=True)

    edge = subprocess.Popen(
        [
            str(EDGE_PATH),
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={PORT}",
            f"--user-data-dir={profile_dir}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        targets = fetch_json(f"http://127.0.0.1:{PORT}/json/list")
        page = next((item for item in targets if item.get("type") == "page"), targets[0])
        websocket_url = page.get("webSocketDebuggerUrl")
        if not websocket_url:
            raise RuntimeError("No debuggable page target found")

        async with websockets.connect(websocket_url, max_size=None) as websocket_connection:
            client = CdpClient(websocket_connection)
            client.capture_directory = out_dir
            await client.start()
            await client.send("Page.enable")
            await client.send("Runtime.enable")
            await client.send(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 390,
                    "height": 844,
                    "deviceScaleFactor": 3,
                    "mobile": True,
                    "screenWidth": 390,
                    "screenHeight": 844,
                },
            )
            await client.send("Emulation.setTouchEmulationEnabled", {"enabled": True})

            load_event = asyncio.create_task(client.once("Page.loadEventFired"))
            await client.send("Page.navigate", {"url": args.url})
            await load_event

            card_count = 0
            for _ in range(80):
                card_count = await client.evaluate(
                    "document.querySelectorAll('.product-card[data-product-id]').length"
                )
                if card_count and card_count > 0:
                    break
                await asyncio.sleep(0.2)

            if not card_count:
                retry_url = f"{args.url}{'&' if '?' in args.url else '?'}smokeRetry=1"
                load_event = asyncio.create_task(client.once("Page.loadEventFired"))
                await client.send("Page.navigate", {"url": retry_url})
                await load_event
                for _ in range(100):
                    card_count = await client.evaluate(
                        "document.querySelectorAll('.product-card[data-product-id]').length"
                    )
                    if card_count and card_count > 0:
                        break
                    await asyncio.sleep(0.2)

            # Product cards can render before the responsive helpers finish
            # inserting the mobile-only filter trigger, so wait for the full
            # mobile chrome before measuring drawer/menu geometry.
            await client.evaluate("window.dispatchEvent(new Event('resize'));")
            for _ in range(80):
                mobile_controls_ready = await client.evaluate(
                    "Boolean(document.querySelector('.mobile-filter-trigger') && document.getElementById('navToggle') && document.getElementById('siteNav'))"
                )
                if mobile_controls_ready:
                    break
                await asyncio.sleep(0.2)

            nav_state = await client.evaluate(
                """(async () => {
                  const toRect = (rect) => rect ? ({
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height
                  }) : null;
                  const toggle = document.getElementById('navToggle');
                  const nav = document.getElementById('siteNav');
                  if (!toggle || !nav) return { error: 'missing mobile nav controls' };
                  toggle.click();
                  await new Promise((resolve) => setTimeout(resolve, 180));
                  const openRect = nav.getBoundingClientRect();
                  const openState = {
                    isOpen: nav.classList.contains('open'),
                    isHidden: nav.hidden,
                    ariaHidden: nav.getAttribute('aria-hidden'),
                    toggleExpanded: toggle.getAttribute('aria-expanded'),
                    rect: toRect(openRect)
                  };
                  toggle.click();
                  await new Promise((resolve) => setTimeout(resolve, 180));
                  return {
                    openState,
                    closedState: {
                      isOpen: nav.classList.contains('open'),
                      isHidden: nav.hidden,
                      ariaHidden: nav.getAttribute('aria-hidden'),
                      toggleExpanded: toggle.getAttribute('aria-expanded')
                    }
                  };
                })()"""
            )

            theme_state = await client.evaluate(
                """(() => {
                  const toggle = document.getElementById('themeToggle');
                  if (!toggle) return { error: 'missing theme toggle' };
                  return {
                    inFooterActions: !!toggle.closest('.footer-actions'),
                    inHeaderActions: !!toggle.closest('.header-actions'),
                    hasFooterClass: toggle.classList.contains('theme-toggle--footer'),
                    label: toggle.textContent.trim()
                  };
                })()"""
            )

            filter_state = await client.evaluate(
                """(async () => {
                  const toRect = (rect) => rect ? ({
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height
                  }) : null;
                  let trigger = document.querySelector('.mobile-filter-trigger');
                  for (let i = 0; !trigger && i < 40; i += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    trigger = document.querySelector('.mobile-filter-trigger');
                  }
                  if (!trigger) return { error: 'missing trigger' };
                  trigger.click();
                  // Wait through the drawer transition before measuring; otherwise
                  // the panel can be sampled while it is still off canvas.
                  await new Promise((resolve) => setTimeout(resolve, 350));
                  const panel = document.querySelector('.filter-panel');
                  const closeButton = document.querySelector('.filter-panel-dismiss');
                  const panelRect = panel?.getBoundingClientRect();
                  const closeRect = closeButton?.getBoundingClientRect();
                  return {
                    bodyOpen: document.body.classList.contains('filters-open'),
                    panelRect: toRect(panelRect),
                    closeRect: toRect(closeRect),
                    closeOnRightHalf: !!panelRect && !!closeRect ? closeRect.left > (panelRect.left + panelRect.width / 2) : false,
                    closeNearTop: !!panelRect && !!closeRect ? closeRect.top <= (panelRect.top + 28) : false
                  };
                })()"""
            )
            filter_screenshot = await client.capture("mobile-filter-drawer.png")

            await client.evaluate("document.querySelector('.filter-panel-dismiss')?.click();")
            await asyncio.sleep(0.35)

            modal_state = await client.evaluate(
                """(async () => {
                  const toRect = (rect) => rect ? ({
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height
                  }) : null;
                  const card = document.querySelector('.product-card[data-product-id]');
                  if (!card) return { error: 'missing product card' };
                  card.scrollIntoView({ block: 'center', inline: 'nearest' });
                  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  card.click();
                  for (let i = 0; i < 15; i += 1) {
                    if (document.querySelector('#productModal.active')) break;
                    await new Promise((resolve) => setTimeout(resolve, 80));
                  }
                  if (!document.querySelector('#productModal.active')) {
                    const media = card.querySelector('.product-media img, .product-media');
                    media?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
                  }
                  for (let i = 0; i < 20; i += 1) {
                    if (document.querySelector('#productModal.active')) break;
                    await new Promise((resolve) => setTimeout(resolve, 80));
                  }
                  const modal = document.querySelector('#productModal.active');
                  const closeButton = modal?.querySelector('.modal-close');
                  const rect = closeButton?.getBoundingClientRect();
                  const rootStyles = getComputedStyle(document.documentElement);
                  const closeStyles = closeButton ? getComputedStyle(closeButton) : null;
                  const stylesheetInfo = Array.from(document.styleSheets).map((sheet) => {
                    try {
                      const modalRule = Array.from(sheet.cssRules || []).find((rule) => rule.cssText?.includes('.modal-close'));
                      return {
                        href: sheet.href,
                        hasModalRule: !!modalRule,
                        modalRuleText: modalRule?.cssText || null
                      };
                    } catch (error) {
                      return {
                        href: sheet.href,
                        hasModalRule: false,
                        modalRuleText: null
                      };
                    }
                  });
                  return {
                    modalOpen: !!modal,
                    closeExists: !!closeButton,
                    closeVisible: !!closeButton && !!rect && rect.width > 0 && rect.height > 0,
                    closeRect: toRect(rect),
                    closeWithinViewport: !!rect ? rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight : false,
                    closeComputedTop: closeStyles?.top || null,
                    headerHeightVar: rootStyles.getPropertyValue('--header-h').trim() || null,
                    stylesheetInfo
                  };
                })()"""
            )
            modal_screenshot = await client.capture("mobile-product-modal.png")

            modal_closed = await client.evaluate(
                """(async () => {
                  document.querySelector('#productModal.active .modal-close')?.click();
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  return { modalStillOpen: !!document.querySelector('#productModal.active') };
                })()"""
            )

            print(
                json.dumps(
                    {
                        "filterState": filter_state,
                        "navState": nav_state,
                        "themeState": theme_state,
                        "modalState": modal_state,
                        "modalClosed": modal_closed,
                        "filterShot": filter_screenshot,
                        "modalShot": modal_screenshot,
                    },
                    indent=2,
                )
            )
            failures = []
            if filter_state.get("error") or not filter_state.get("bodyOpen"):
                failures.append({"check": "filter drawer opens", "state": filter_state})
            if not filter_state.get("closeOnRightHalf") or not filter_state.get("closeNearTop"):
                failures.append({"check": "filter close button placement", "state": filter_state})
            if not nav_state.get("openState", {}).get("isOpen") or not nav_state.get("closedState", {}).get("isHidden"):
                failures.append({"check": "mobile nav toggles", "state": nav_state})
            if not modal_state.get("modalOpen") or not modal_state.get("closeWithinViewport"):
                failures.append({"check": "product modal close visible", "state": modal_state})
            if modal_closed.get("modalStillOpen"):
                failures.append({"check": "product modal closes", "state": modal_closed})
            if failures:
                raise SystemExit(json.dumps({"mobileSmokeFailures": failures}, indent=2))
    finally:
        try:
            edge.kill()
        except Exception:  # pragma: no cover - cleanup helper
            pass
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
