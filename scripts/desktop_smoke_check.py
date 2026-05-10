"""Run a desktop browser smoke test against the local static site.

The site is still mostly static HTML/CSS/JS, so this script keeps verification
lightweight: it launches Edge through the Chrome DevTools Protocol, waits for
each page to render, checks for broken visible images, confirms catalog cards
are present on product pages, and verifies that the product detail modal can be
opened and closed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets


EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
DEFAULT_BASE_URL = "http://127.0.0.1:4173"
DEFAULT_OUT = Path(r"H:\My Drive\djshouseofcards-next-fixes-applied\outputs\desktop-smoke.json")
DEFAULT_PAGES = (
    "index.html",
    "sports-cards.html",
    "baseball-cards.html",
    "basketball-cards.html",
    "football-cards.html",
    "comics.html",
    "collectibles.html",
    "about.html",
    "contact.html",
    "wishlist.html",
    "admin.html",
)
PRODUCT_PAGE_MARKERS = ("baseball-cards", "basketball-cards", "football-cards", "comics", "collectibles")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test local desktop pages.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--port", type=int, default=9234)
    return parser.parse_args()


def fetch_json(url: str, attempts: int = 80) -> dict | list:
    last_error: Exception | None = None
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                return json.load(response)
        except Exception as exc:  # pragma: no cover - local smoke helper
            last_error = exc
            time.sleep(0.2)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


class CdpClient:
    def __init__(self, websocket_connection):
        self.websocket_connection = websocket_connection
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._events: dict[str, asyncio.Future] = {}
        self.console_messages: list[dict[str, str]] = []
        self.exceptions: list[str] = []

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
            params = payload.get("params", {})
            if method == "Runtime.consoleAPICalled" and params.get("type") in {"error", "warning"}:
                text = " ".join(str(arg.get("value", arg.get("description", ""))) for arg in params.get("args", []))
                self.console_messages.append({"level": params.get("type", ""), "text": text[:300]})
            elif method == "Runtime.exceptionThrown":
                details = params.get("exceptionDetails", {})
                exception = details.get("exception") or {}
                description = exception.get("description") or exception.get("value") or details.get("text", "Runtime exception")
                stack_call_frames = (details.get("stackTrace") or {}).get("callFrames") or []
                # Edge can load browser-extension helpers even in an isolated
                # smoke profile. Those errors are outside the site and should
                # not fail a production storefront check.
                if any(str(frame.get("url", "")).startswith("chrome-extension://") for frame in stack_call_frames):
                    continue
                location = ""
                if stack_call_frames:
                    frame = stack_call_frames[0]
                    location = f" at {frame.get('url', '')}:{frame.get('lineNumber', 0) + 1}:{frame.get('columnNumber', 0) + 1}"
                self.exceptions.append(f"{description}{location}"[:700])

            if method and method in self._events and not self._events[method].done():
                self._events[method].set_result(params)

    async def send(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        message_id = self._next_id
        future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        await self.websocket_connection.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        return await future

    async def once(self, method: str) -> dict:
        future = asyncio.get_running_loop().create_future()
        self._events[method] = future
        return await future

    async def evaluate(self, expression: str):
        result = await self.send(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
        )
        return result.get("result", {}).get("value")


async def wait_for(client: CdpClient, expression: str, timeout: float = 12):
    end_time = time.time() + timeout
    last_value = None
    while time.time() < end_time:
        last_value = await client.evaluate(expression)
        if last_value:
            return last_value
        await asyncio.sleep(0.2)
    return last_value


async def navigate(client: CdpClient, url: str) -> None:
    load_event = asyncio.create_task(client.once("Page.loadEventFired"))
    await client.send("Page.navigate", {"url": url})
    await asyncio.wait_for(load_event, timeout=20)
    await wait_for(client, "document.readyState === 'complete'", timeout=8)


async def inspect_page(client: CdpClient, base_url: str, page: str) -> dict:
    client.console_messages.clear()
    client.exceptions.clear()
    target_url = f"{base_url.rstrip('/')}/{page}"
    await navigate(client, target_url)

    if any(marker in page for marker in PRODUCT_PAGE_MARKERS):
        await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)

    async def collect_summary() -> dict:
        return await client.evaluate(
            """(() => {
              const images = Array.from(document.images);
              const brokenImages = images
                .filter((image) => image.complete && image.naturalWidth === 0)
                .map((image) => image.currentSrc || image.src)
                .slice(0, 10);
              const header = document.querySelector('.site-header');
              const footer = document.querySelector('.site-footer, .footer, footer');
              const text = document.body ? document.body.innerText : '';
              return {
                title: document.title,
                productCards: document.querySelectorAll('.product-card[data-product-id]').length,
                brokenImageCount: brokenImages.length,
                brokenImageSample: brokenImages,
                headerVisible: Boolean(header && header.getBoundingClientRect().height > 20),
                footerPresent: Boolean(footer),
                containsSlash2022: text.includes('\\\\2022')
              };
            })()"""
        )

    summary = await collect_summary()

    # Supabase-backed pages can occasionally finish the document load before the
    # first catalog batch paints in a clean browser profile. Retry once so the
    # smoke test reports real storefront failures instead of transient timing.
    if any(marker in page for marker in PRODUCT_PAGE_MARKERS) and not summary.get("productCards"):
        await asyncio.sleep(0.8)
        await navigate(client, f"{target_url}{'&' if '?' in target_url else '?'}smokeRetry=1")
        await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=20)
        summary = await collect_summary()

    return {
        "page": page,
        **summary,
        "warnings": client.console_messages[:5],
        "exceptions": client.exceptions[:5],
    }


async def inspect_product_modal(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/baseball-cards.html")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    return await client.evaluate(
        """(async () => {
          const card = document.querySelector('.product-card[data-product-id]');
          if (!card) return { modalOpen: false, reason: 'missing product card' };
          card.click();
          await new Promise((resolve) => setTimeout(resolve, 450));
          const modal = document.querySelector('#productModal.active');
          const close = modal?.querySelector('.modal-close');
          const rect = close?.getBoundingClientRect();
          close?.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            modalOpen: Boolean(modal),
            closeVisible: Boolean(rect && rect.width > 20 && rect.height > 20),
            closeWithinViewport: Boolean(rect && rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
            modalClosed: !document.querySelector('#productModal.active')
          };
        })()"""
    )


async def main() -> int:
    args = parse_args()
    out_path = Path(args.out)
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "pages": [], "failures": []}

    if not EDGE_PATH.exists():
        raise FileNotFoundError(f"Edge not found at {EDGE_PATH}")

    profile_dir = Path(tempfile.gettempdir()) / f"dj-edge-desktop-{int(time.time() * 1000)}"
    edge = subprocess.Popen(
        [
            str(EDGE_PATH),
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={args.port}",
            f"--user-data-dir={profile_dir}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        targets = fetch_json(f"http://127.0.0.1:{args.port}/json/list")
        page_target = next((target for target in targets if target.get("type") == "page"), targets[0])
        async with websockets.connect(page_target["webSocketDebuggerUrl"], max_size=None) as websocket_connection:
            client = CdpClient(websocket_connection)
            await client.start()
            await client.send("Page.enable")
            await client.send("Runtime.enable")
            await client.send(
                "Emulation.setDeviceMetricsOverride",
                {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False},
            )

            for page in DEFAULT_PAGES:
                page_report = await inspect_page(client, args.base_url, page)
                report["pages"].append(page_report)
                if page_report["brokenImageCount"] or not page_report["headerVisible"] or page_report["containsSlash2022"]:
                    report["failures"].append(page_report)
                if any(marker in page for marker in PRODUCT_PAGE_MARKERS) and page_report["productCards"] <= 0:
                    report["failures"].append({**page_report, "reason": "No product cards rendered"})
                if page_report["exceptions"]:
                    report["failures"].append({**page_report, "reason": "Runtime exception"})

            modal_report = await inspect_product_modal(client, args.base_url)
            report["desktopModalCheck"] = modal_report
            if not (modal_report.get("modalOpen") and modal_report.get("closeVisible") and modal_report.get("closeWithinViewport") and modal_report.get("modalClosed")):
                report["failures"].append({"page": "baseball-cards.html", "modal": modal_report})
    finally:
        edge.terminate()
        try:
            edge.wait(timeout=8)
        except subprocess.TimeoutExpired:
            edge.kill()
        shutil.rmtree(profile_dir, ignore_errors=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"pages": len(report["pages"]), "failures": len(report["failures"]), "out": str(out_path)}, indent=2))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
