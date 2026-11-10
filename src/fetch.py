from __future__ import annotations

import httpx
from bs4 import BeautifulSoup

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def fetch_html(url: str, timeout: float = 30.0) -> str:
    """Récupère le HTML brut d'une page (suit les redirections)."""
    headers = {"User-Agent": _UA, "Accept-Language": "en,de;q=0.8"}
    with httpx.Client(follow_redirects=True, headers=headers, timeout=timeout) as client:
        resp = client.get(url)
        resp.raise_for_status()
        return resp.text


def fetch_many(urls, workers: int = 6, timeout: float = 20.0) -> dict:
    """{url: html} pour plusieurs pages en parallèle (opéras, Philharmonie :
    une page par production). Une page en échec est simplement absente."""
    from concurrent.futures import ThreadPoolExecutor

    urls = list(dict.fromkeys(urls))

    def one(u):
        try:
            return u, fetch_html(u, timeout=timeout)
        except Exception:  # noqa: BLE001 — on garde les autres pages
            return u, None

    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(urls) or 1))) as pool:
        return {u: h for u, h in pool.map(one, urls) if h is not None}


def html_to_text(html: str, max_chars: int = 60_000) -> str:
    """Nettoie le HTML pour réduire le nombre de tokens envoyés au LLM.

    On retire scripts/styles/nav/footer et on garde les liens sous forme
    « texte (URL) » pour que le modèle puisse extraire les liens de résa.
    """
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "header", "footer", "nav"]):
        tag.decompose()

    # Rendre les liens visibles pour le LLM.
    for a in soup.find_all("a", href=True):
        href = a["href"]
        label = a.get_text(strip=True)
        a.replace_with(f"{label} <{href}>")

    text = soup.get_text(separator="\n")
    lines = [ln.strip() for ln in text.splitlines()]
    text = "\n".join(ln for ln in lines if ln)
    return text[:max_chars]
