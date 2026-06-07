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
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "outputs" / "desktop-smoke.json"
DEFAULT_PAGES = (
    "index.html",
    "shop.html",
    "sports-cards.html",
    "baseball-cards.html",
    "basketball-cards.html",
    "football-cards.html",
    "comics.html",
    "collectibles.html",
    "about.html",
    "contact.html",
    "account.html",
    "wishlist.html",
    "admin.html",
    "offline.html",
)
PRODUCT_PAGE_MARKERS = ("baseball-cards", "basketball-cards", "football-cards", "comics", "collectibles")
LIGHTWEIGHT_PAGE_MARKERS = ("about.html", "contact.html", "shop.html", "sports-cards.html")
HEADER_OPTIONAL_PAGES = ("offline.html",)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test local desktop pages.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--port", type=int, default=9234)
    parser.add_argument("--skip-checkout", action="store_true", help="Skip the checkout/auth interaction for production-safe checks.")
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
        self.request_urls: dict[str, str] = {}
        self.http_errors: list[dict[str, str | int]] = []
        self.network_failures: list[dict[str, str]] = []

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
            elif method == "Network.requestWillBeSent":
                request_id = str(params.get("requestId", ""))
                request_url = str((params.get("request") or {}).get("url", ""))
                if request_id and request_url:
                    self.request_urls[request_id] = request_url
            elif method == "Network.responseReceived":
                response = params.get("response") or {}
                status = int(response.get("status") or 0)
                response_url = str(response.get("url") or "")
                if status >= 400 and not response_url.startswith("chrome-extension://"):
                    self.http_errors.append({"status": status, "url": response_url[:500]})
            elif method == "Network.loadingFailed":
                request_id = str(params.get("requestId", ""))
                error_text = str(params.get("errorText") or "")
                request_url = self.request_urls.get(request_id, "")
                if error_text != "net::ERR_ABORTED" and not request_url.startswith("chrome-extension://"):
                    self.network_failures.append({"error": error_text[:200], "url": request_url[:500]})

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
    try:
        await asyncio.wait_for(load_event, timeout=20)
    except TimeoutError:
        # A slow image or third-party request can delay the final load event
        # after the page is already usable. Only fail if the DOM is not ready.
        if not await wait_for(client, "document.readyState === 'interactive' || document.readyState === 'complete'", timeout=10):
            raise
    await wait_for(client, "document.readyState === 'complete' || document.readyState === 'interactive'", timeout=8)


async def inspect_page(client: CdpClient, base_url: str, page: str) -> dict:
    client.console_messages.clear()
    client.exceptions.clear()
    client.request_urls.clear()
    client.http_errors.clear()
    client.network_failures.clear()
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
              const productGrid = document.querySelector('.catalog-results-column .products-grid');
              const productGridColumns = productGrid
                ? getComputedStyle(productGrid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
                : 0;
              const text = document.body ? document.body.innerText : '';
              const unlabeledControls = Array.from(document.querySelectorAll('input, select, textarea'))
                .filter((control) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(control.type))
                .filter((control) => control.getAttribute('aria-hidden') !== 'true')
                .filter((control) => !(control.labels && control.labels.length))
                .filter((control) => !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby'))
                .map((control) => control.id || control.name || control.tagName.toLowerCase())
                .slice(0, 10);
              const unnamedButtons = Array.from(document.querySelectorAll('button'))
                .filter((button) => !button.textContent.trim())
                .filter((button) => !button.getAttribute('aria-label') && !button.getAttribute('aria-labelledby') && !button.title)
                .map((button) => button.id || button.className || 'button')
                .slice(0, 10);
              const visibleProductSignatures = Array.from(document.querySelectorAll('.product-card[data-product-id]')).map((card) => [
                card.querySelector('h3, h4')?.textContent?.trim().toLowerCase() || '',
                card.querySelector('.product-price')?.textContent?.trim().toLowerCase() || '',
                card.querySelector('.product-media img')?.currentSrc || card.querySelector('.product-media img')?.src || ''
              ].join('|'));
              return {
                title: document.title,
                productCards: document.querySelectorAll('.product-card[data-product-id]').length,
                productGridColumns,
                brokenImageCount: brokenImages.length,
                brokenImageSample: brokenImages,
                headerVisible: Boolean(header && header.getBoundingClientRect().height > 20),
                footerPresent: Boolean(footer),
                accountNavLinks: document.querySelectorAll('.site-nav a[href="account.html"]').length,
                wrongPublicContactEmailPresent: text.includes('djwandrei@gmail.com') || text.includes('contact@djshouseofcards-comics.com'),
                duplicateVisibleProductCards: visibleProductSignatures.length - new Set(visibleProductSignatures).size,
                preloadedProductScriptCount: document.querySelectorAll('script[data-preloaded-product-source]').length,
                backendScriptCount: Array.from(document.scripts).filter((script) => /(?:backend-config|supabase-client|payments)\\.js(?:\\?|$)/.test(script.src)).length,
                unlabeledControls,
                unnamedButtons,
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
        "httpErrors": client.http_errors[:10],
        "networkFailures": client.network_failures[:10],
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
          const mainImage = modal?.querySelector('#modalMainImage');
          const rect = close?.getBoundingClientRect();
          const modalImageSource = mainImage?.currentSrc || mainImage?.src || '';
          const fullSizeSource = mainImage?.dataset.fullSizeSrc || '';
          const modalUsesThumbnailPreview = !modalImageSource.includes('/assets/')
            || modalImageSource.includes('/assets/thumbnails/');
          const fullSizeSourcePreserved = !fullSizeSource
            || (!fullSizeSource.includes('/assets/thumbnails/') && fullSizeSource !== modalImageSource);
          close?.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            modalOpen: Boolean(modal),
            closeVisible: Boolean(rect && rect.width > 20 && rect.height > 20),
            closeWithinViewport: Boolean(rect && rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
            modalImageLoaded: Boolean(mainImage?.complete && mainImage?.naturalWidth > 0),
            modalUsesThumbnailPreview,
            fullSizeSourcePreserved,
            modalClosed: !document.querySelector('#productModal.active')
          };
        })()"""
    )


async def inspect_home_featured_flow(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/index.html")
    await client.evaluate(
        """(() => {
          document.getElementById('featuredProducts')?.scrollIntoView({ block: 'center' });
          return true;
        })()"""
    )
    await wait_for(client, "document.querySelectorAll('#featuredProducts .product-card[data-product-id]').length > 0", timeout=20)
    return await client.evaluate(
        """(() => ({
          featuredCards: document.querySelectorAll('#featuredProducts .product-card[data-product-id]').length,
          catalogScripts: Array.from(document.scripts).filter((script) => /catalog\\.js(?:\\?|$)/.test(script.src)).length,
          backendScripts: Array.from(document.scripts).filter((script) => /(?:backend-config|supabase-client|payments)\\.js(?:\\?|$)/.test(script.src)).length,
          brokenFeaturedImages: Array.from(document.querySelectorAll('#featuredProducts img'))
            .filter((image) => image.complete && image.naturalWidth === 0)
            .length
        }))()"""
    )


async def inspect_filtered_catalog(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/basketball-cards.html?search=Amare")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    return await client.evaluate(
        """(() => {
          const grid = document.querySelector('.catalog-results-column .products-grid');
          const card = grid?.querySelector('.product-card[data-product-id]');
          const gridRect = grid?.getBoundingClientRect();
          const cardRect = card?.getBoundingClientRect();
          return {
            productCards: grid?.querySelectorAll('.product-card[data-product-id]').length || 0,
            productGridColumns: grid
              ? getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
              : 0,
            gridWidth: gridRect?.width || 0,
            firstCardWidth: cardRect?.width || 0
          };
        })()"""
    )


async def inspect_ranged_price(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/basketball-cards.html?search=Damian%20Lillard")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    return await client.evaluate(
        """(() => {
          const cards = Array.from(document.querySelectorAll('.product-card[data-product-id]'));
          const card = cards.find((candidate) =>
            /2012-13 Panini Brilliance Team Tomorrow #9 Damian Lillard/i.test(
              candidate.querySelector('h3, h4')?.textContent || ''
            )
          );
          return {
            found: Boolean(card),
            productId: card?.dataset.productId || '',
            displayedPrice: card?.querySelector('.product-price')?.textContent?.trim() || '',
            guideRange: card?.querySelector('.product-price-note')?.textContent?.trim() || ''
          };
        })()"""
    )


async def inspect_account_page(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/account.html")
    return await client.evaluate(
        """(() => {
          localStorage.removeItem('djCustomerProfileV1');
          const nameInput = document.getElementById('account_fullName');
          const emailInput = document.getElementById('account_email');
          const preferredContactInput = document.getElementById('account_preferredContact');
          const favoritePlayersInput = document.getElementById('account_favoritePlayers');
          const notesInput = document.getElementById('account_notes');
          const form = document.getElementById('accountProfileForm');
          const status = document.getElementById('accountStatus');
          if (!nameInput || !notesInput || !form || !status) {
            return { ready: false, reason: 'missing account form nodes' };
          }
          nameInput.value = 'Smoke Test Buyer';
          if (emailInput) emailInput.value = 'smoke@example.com';
          if (preferredContactInput) preferredContactInput.value = 'Email';
          if (favoritePlayersInput) favoritePlayersInput.value = 'Hank Aaron, Magic Johnson';
          notesInput.value = 'Interested in Braves, Bulls, and graded vintage.';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          const savedProfile = JSON.parse(localStorage.getItem('djCustomerProfileV1') || '{}');
          const navAccountLink = document.querySelector('.site-nav a[href="account.html"], .primary-nav a[href="account.html"]');
          const footer = document.querySelector('footer, .footer');
          const orderPanel = document.getElementById('accountOrders');
          const readiness = document.getElementById('accountProfileCompletionLabel');
          const wishlistPreview = document.getElementById('accountWishlistPreview');
          const buyerActionsReady = Boolean(
            document.getElementById('accountEmailPreferences') &&
            document.querySelector('a[href="wishlist.html"]')
          );
          const removedAccountToolsGone = [
            'accountCopyInquiry',
            'accountCopyWishlist',
            'accountCopySearchLinks',
            'accountExportWishlistCsv',
            'accountExportBuyerPacket',
            'accountCopyProfile',
            'accountCleanWishlist',
            'accountExportDetails',
            'accountImportDetails'
          ]
            .every((id) => !document.getElementById(id));
          return {
            ready: true,
            savedName: savedProfile.fullName || '',
            savedNotes: savedProfile.notes || '',
            savedFavoritePlayers: savedProfile.favoritePlayers || '',
            statusText: status.textContent.trim(),
            navAccountLink: Boolean(navAccountLink),
            footerPresent: Boolean(footer),
            readinessReady: Boolean(readiness && readiness.textContent.trim()),
            wishlistPreviewReady: Boolean(wishlistPreview),
            orderPanelReady: Boolean(orderPanel && orderPanel.textContent.includes('No saved checkout activity yet')),
            buyerActionsReady,
            removedAccountToolsGone
          };
        })()"""
    )


async def inspect_contact_form(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/contact.html")
    return await client.evaluate(
        """(() => {
          const form = document.getElementById('contactForm');
          const status = document.getElementById('contactStatus');
          const name = document.getElementById('contactName');
          const email = document.getElementById('contactEmail');
          const subject = document.getElementById('contactSubject');
          const message = document.getElementById('contactMessage');
          const buyingTopic = document.querySelector('[data-contact-topic="buying"]');
          if (!form || !status || !name || !email || !subject || !message || !buyingTopic) {
            return { ready: false, reason: 'missing contact form nodes' };
          }

          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          const requiredStatus = status.textContent.trim();
          const requiredFocus = document.activeElement?.id || '';

          buyingTopic.click();
          const topicSubject = subject.value;
          const topicPromptAdded = message.value.includes("I'm interested in this item or category:");

          name.value = 'Smoke Test Buyer';
          email.value = 'not-an-email';
          message.value = 'Testing contact validation without opening an email client.';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          const invalidEmailStatus = status.textContent.trim();
          const invalidEmailFocus = document.activeElement?.id || '';

          return {
            ready: true,
            requiredStatus,
            requiredFocus,
            topicSubject,
            topicPromptAdded,
            invalidEmailStatus,
            invalidEmailFocus
          };
        })()"""
    )


async def inspect_local_wishlist_flow(client: CdpClient, base_url: str) -> dict:
    custom_id = 99000001
    await navigate(client, f"{base_url.rstrip('/')}/baseball-cards.html")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    await client.evaluate(
        f"""(() => {{
          const custom = {{
            id: {custom_id},
            name: 'AAA Smoke Test Local Wishlist Card',
            category: 'Baseball',
            team: 'Smoke Test Team',
            year: 2026,
            condition: 'Ungraded',
            price: 12.34,
            image: 'assets/dj-logo.png',
            description: 'Temporary isolated-browser smoke listing.'
          }};
          window.DJ.saveCustomProducts([custom]);
          window.DJ.setWishlist([{custom_id}]);
          return true;
        }})()"""
    )

    await navigate(client, f"{base_url.rstrip('/')}/wishlist.html")
    await wait_for(
        client,
        f"Boolean(document.querySelector('.product-card[data-product-id=\"{custom_id}\"]'))",
        timeout=20,
    )
    result = await client.evaluate(
        f"""(() => {{
          const card = document.querySelector('.product-card[data-product-id="{custom_id}"]');
          const result = {{
            cardFound: Boolean(card),
            title: card?.querySelector('h3, h4')?.textContent?.trim() || '',
            pageCount: document.getElementById('wishlistPageCount')?.textContent?.trim() || '',
            headerCount: document.querySelector('[data-wishlist-count]')?.textContent?.trim() || ''
          }};
          window.DJ.setWishlist([]);
          window.DJ.saveCustomProducts([]);
          return result;
        }})()"""
    )
    return result


async def inspect_catalog_mutation_history_flow(client: CdpClient, base_url: str) -> dict:
    custom_id = 99000002
    custom_name = "AAA Smoke Test History Card"
    await navigate(client, f"{base_url.rstrip('/')}/baseball-cards.html")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    await client.evaluate(
        f"""(() => {{
          window.DJ.saveCustomProducts([{{
            id: {custom_id},
            name: '{custom_name}',
            category: 'Baseball',
            team: 'Smoke Test Team',
            year: 2026,
            condition: 'Ungraded',
            price: 23.45,
            image: 'assets/dj-logo.png',
            description: 'Temporary isolated-browser history smoke listing.'
          }}]);
          return true;
        }})()"""
    )
    await wait_for(client, "document.body.dataset.catalogMutationRefreshBound === 'true'", timeout=5)
    await client.evaluate(
        f"""(() => {{
          const search = document.getElementById('searchInput');
          if (!search) return false;
          search.value = '{custom_name}';
          search.dispatchEvent(new Event('input', {{ bubbles: true }}));
          return true;
        }})()"""
    )
    appeared_after_mutation = bool(
        await wait_for(
            client,
            f"Boolean(document.querySelector('.product-card[data-product-id=\"{custom_id}\"]'))",
            timeout=20,
        )
    )
    await client.evaluate(
        f"""(() => {{
          const url = new URL(window.location.href);
          url.searchParams.set('search', '{custom_name}');
          window.history.pushState({{}}, '', `${{url.pathname}}${{url.search}}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
          return true;
        }})()"""
    )
    survived_history_navigation = bool(
        await wait_for(
            client,
            f"Boolean(document.querySelector('.product-card[data-product-id=\"{custom_id}\"]'))",
            timeout=20,
        )
    )
    result = await client.evaluate(
        f"""(() => {{
          const card = document.querySelector('.product-card[data-product-id="{custom_id}"]');
          const result = {{
            appearedAfterMutation: {str(appeared_after_mutation).lower()},
            survivedHistoryNavigation: {str(survived_history_navigation).lower()},
            title: card?.querySelector('h3, h4')?.textContent?.trim() || '',
            resultsCount: document.getElementById('resultsCount')?.textContent?.trim() || ''
          }};
          window.DJ.saveCustomProducts([]);
          return result;
        }})()"""
    )
    return result


async def inspect_checkout_auth_flow(client: CdpClient, base_url: str) -> dict:
    await navigate(client, f"{base_url.rstrip('/')}/baseball-cards.html")
    await wait_for(client, "document.querySelectorAll('.product-card[data-product-id]').length > 0", timeout=15)
    return await client.evaluate(
        """(async () => {
          const cards = Array.from(document.querySelectorAll('.product-card[data-product-id]'));
          const directPriceCard = cards.find((card) => {
            const price = card.querySelector('.product-price')?.textContent || '';
            return /^\\s*\\$\\s*\\d/.test(price) && !/(?:-|\\u2013|\\u2014|\\bto\\b|contact|ask|inquir)/i.test(price);
          });

          if (!directPriceCard) {
            return { eligibleCardFound: false, reason: 'no single-price product card on first page' };
          }

          directPriceCard.scrollIntoView({ block: 'center', inline: 'nearest' });
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const productId = directPriceCard.dataset.productId || '';
          directPriceCard.click();
          for (let i = 0; i < 30; i += 1) {
            if (document.querySelector('#productModal.active')) break;
            await new Promise((resolve) => setTimeout(resolve, 80));
          }

          const buyButton = document.getElementById('modalBuy');
          const modalTitle = document.getElementById('modalTitle')?.textContent?.trim() || '';
          if (!buyButton) {
            return { eligibleCardFound: true, authModalOpen: false, reason: 'missing Buy Now button' };
          }

          const paymentsReady = Boolean(window.DJ?.payments?.startCheckout);
          const backendReady = Boolean(window.DJ?.remoteCatalog?.isConfigured?.());
          const invokeReady = Boolean(window.DJ?.remoteCatalog?.invokeFunction);
          let checkoutBridgeCalled = false;
          let checkoutBridgeProductId = '';
          if (paymentsReady && !window.__desktopSmokeCheckoutWrapped) {
            const originalStartCheckout = window.DJ.payments.startCheckout;
            window.DJ.payments.startCheckout = (product, options) => {
              checkoutBridgeCalled = true;
              checkoutBridgeProductId = String(product?.id || '');
              return originalStartCheckout(product, options);
            };
            window.__desktopSmokeCheckoutWrapped = true;
          }
          const beforeUrl = window.location.href;
          buyButton.click();
          for (let i = 0; i < 90; i += 1) {
            if (document.querySelector('#customerAuthModal.active')) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          const authModal = document.getElementById('customerAuthModal');
          const authModalOpenBeforeClose = Boolean(authModal?.classList.contains('active'));
          const statusText = document.getElementById('modalCheckoutStatus')?.textContent?.trim() || '';
          const authClose = authModal?.querySelector('[data-customer-auth-close]');
          authClose?.click();
          document.querySelector('#productModal.active .modal-close')?.click();
          await new Promise((resolve) => setTimeout(resolve, 120));

          return {
            eligibleCardFound: true,
            productId,
            modalTitle,
            paymentsReady,
            backendReady,
            invokeReady,
            checkoutBridgeCalled,
            checkoutBridgeProductId,
            urlChanged: beforeUrl !== window.location.href,
            authModalOpen: authModalOpenBeforeClose,
            authModalClosed: !document.querySelector('#customerAuthModal.active'),
            productModalClosed: !document.querySelector('#productModal.active'),
            statusText
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
            await client.send("Network.enable")
            await client.send(
                "Emulation.setDeviceMetricsOverride",
                {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False},
            )

            for page in DEFAULT_PAGES:
                page_report = await inspect_page(client, args.base_url, page)
                report["pages"].append(page_report)
                header_missing = page not in HEADER_OPTIONAL_PAGES and not page_report["headerVisible"]
                if page_report["brokenImageCount"] or header_missing or page_report["containsSlash2022"]:
                    report["failures"].append(page_report)
                if any(marker in page for marker in PRODUCT_PAGE_MARKERS) and page_report["productCards"] <= 0:
                    report["failures"].append({**page_report, "reason": "No product cards rendered"})
                if any(marker in page for marker in PRODUCT_PAGE_MARKERS) and page_report["productGridColumns"] != 5:
                    report["failures"].append({**page_report, "reason": "Desktop product grid is not five columns"})
                if page_report.get("duplicateVisibleProductCards", 0) > 0:
                    report["failures"].append({**page_report, "reason": "Duplicate product cards are visible"})
                if page_report["accountNavLinks"] > 1:
                    report["failures"].append({**page_report, "reason": "Duplicate Account navigation links"})
                if page_report["wrongPublicContactEmailPresent"]:
                    report["failures"].append({**page_report, "reason": "Incorrect public contact email is visible"})
                if page_report["exceptions"]:
                    report["failures"].append({**page_report, "reason": "Runtime exception"})
                if page_report["httpErrors"] or page_report["networkFailures"]:
                    report["failures"].append({**page_report, "reason": "Hidden HTTP or network failure"})
                if page_report["unlabeledControls"] or page_report["unnamedButtons"]:
                    report["failures"].append({**page_report, "reason": "Interactive control lacks an accessible name"})
                if page in LIGHTWEIGHT_PAGE_MARKERS and page_report.get("backendScriptCount", 0) > 0:
                    report["failures"].append({**page_report, "reason": "Lightweight page loaded unused backend or payment scripts"})

            filtered_catalog_report = await inspect_filtered_catalog(client, args.base_url)
            report["filteredCatalogCheck"] = filtered_catalog_report
            if not (
                filtered_catalog_report.get("productCards", 0) > 0
                and filtered_catalog_report.get("productGridColumns") == 5
                and filtered_catalog_report.get("firstCardWidth", 0) > 0
                and filtered_catalog_report.get("firstCardWidth", 0) < filtered_catalog_report.get("gridWidth", 0) * 0.3
            ):
                report["failures"].append({"page": "basketball-cards.html?search=Amare", "filteredCatalog": filtered_catalog_report})

            ranged_price_report = await inspect_ranged_price(client, args.base_url)
            report["rangedPriceCheck"] = ranged_price_report
            if not (
                ranged_price_report.get("found")
                and ranged_price_report.get("displayedPrice") == "$30.00"
                and "$12.00-$30.00" in ranged_price_report.get("guideRange", "")
            ):
                report["failures"].append({"page": "basketball-cards.html?search=Damian%20Lillard", "rangedPrice": ranged_price_report})

            modal_report = await inspect_product_modal(client, args.base_url)
            report["desktopModalCheck"] = modal_report
            if not (
                modal_report.get("modalOpen")
                and modal_report.get("closeVisible")
                and modal_report.get("closeWithinViewport")
                and modal_report.get("modalImageLoaded")
                and modal_report.get("modalUsesThumbnailPreview")
                and modal_report.get("fullSizeSourcePreserved")
                and modal_report.get("modalClosed")
            ):
                report["failures"].append({"page": "baseball-cards.html", "modal": modal_report})

            home_featured_report = await inspect_home_featured_flow(client, args.base_url)
            report["homeFeaturedCheck"] = home_featured_report
            if not (
                home_featured_report.get("featuredCards") == 4
                and home_featured_report.get("catalogScripts") == 1
                and home_featured_report.get("backendScripts") == 0
                and home_featured_report.get("brokenFeaturedImages") == 0
            ):
                report["failures"].append({"page": "index.html", "homeFeatured": home_featured_report})

            account_report = await inspect_account_page(client, args.base_url)
            report["accountPageCheck"] = account_report
            if not (
                account_report.get("ready")
                and account_report.get("savedName") == "Smoke Test Buyer"
                and account_report.get("statusText") == "Buyer details saved on this device."
                and account_report.get("navAccountLink")
                and account_report.get("footerPresent")
                and account_report.get("readinessReady")
                and account_report.get("wishlistPreviewReady")
                and account_report.get("orderPanelReady")
                and account_report.get("buyerActionsReady")
                and account_report.get("removedAccountToolsGone")
            ):
                report["failures"].append({"page": "account.html", "account": account_report})

            contact_report = await inspect_contact_form(client, args.base_url)
            report["contactFormCheck"] = contact_report
            if not (
                contact_report.get("ready")
                and "complete your name, email, and message" in contact_report.get("requiredStatus", "")
                and contact_report.get("requiredFocus") == "contactName"
                and contact_report.get("topicSubject") == "Buying Inquiry"
                and contact_report.get("topicPromptAdded")
                and "valid email address" in contact_report.get("invalidEmailStatus", "")
                and contact_report.get("invalidEmailFocus") == "contactEmail"
            ):
                report["failures"].append({"page": "contact.html", "contactForm": contact_report})

            local_wishlist_report = await inspect_local_wishlist_flow(client, args.base_url)
            report["localWishlistCheck"] = local_wishlist_report
            if not (
                local_wishlist_report.get("cardFound")
                and local_wishlist_report.get("title") == "AAA Smoke Test Local Wishlist Card"
                and local_wishlist_report.get("pageCount") == "1 saved item"
            ):
                report["failures"].append({"page": "wishlist.html", "localWishlist": local_wishlist_report})

            mutation_history_report = await inspect_catalog_mutation_history_flow(client, args.base_url)
            report["catalogMutationHistoryCheck"] = mutation_history_report
            if not (
                mutation_history_report.get("appearedAfterMutation")
                and mutation_history_report.get("survivedHistoryNavigation")
                and mutation_history_report.get("title") == "AAA Smoke Test History Card"
            ):
                report["failures"].append({"page": "baseball-cards.html", "catalogMutationHistory": mutation_history_report})

            if args.skip_checkout:
                report["checkoutAuthCheck"] = {"skipped": True}
            else:
                checkout_report = await inspect_checkout_auth_flow(client, args.base_url)
                report["checkoutAuthCheck"] = checkout_report
                if not (
                    checkout_report.get("eligibleCardFound")
                    and checkout_report.get("authModalOpen")
                    and checkout_report.get("authModalClosed")
                    and checkout_report.get("productModalClosed")
                ):
                    report["failures"].append({"page": "baseball-cards.html", "checkoutAuth": checkout_report})
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
