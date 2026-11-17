"""Une source par type de site. cinema.yaml choisit la source via `source:`."""
from . import babylon, kinoheld, lichtblick, yorck

SOURCES = {
    "kinoheld": kinoheld.fetch,
    "lichtblick": lichtblick.fetch,
    "babylon": babylon.fetch,
    "yorck": yorck.fetch,
}
