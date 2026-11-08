"""Une source par type de site. cinema.yaml choisit la source via `source:`."""
from . import babylon, kinoheld, lichtblick

SOURCES = {
    "kinoheld": kinoheld.fetch,
    "lichtblick": lichtblick.fetch,
    "babylon": babylon.fetch,
}
