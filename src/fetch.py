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
