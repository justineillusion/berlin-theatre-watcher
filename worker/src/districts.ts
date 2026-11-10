// Quartier de chaque lieu (id = venue_slug du nom, voir src/botapi.py), pour le filtre de l'app.
// Nouveau lieu dans config.yaml / cinema.yaml : l'ajouter ici (sinon il n'apparaît que sous « Partout »).
export const DISTRICT: Record<string, string> = {
  // Théâtres
  "schaubuhne": "Wilmersdorf",                                 // Kurfürstendamm 153
  "berliner-ensemble": "Mitte",                                // Bertolt-Brecht-Platz 1
  "volksbuhne": "Mitte",                                       // Rosa-Luxemburg-Platz
  "maxim-gorki-theater": "Mitte",                              // Am Festungsgraben 2
  "hau-hebbel-am-ufer": "Kreuzberg",                           // Hallesches Ufer 32
  "berliner-festspiele-performing-arts-seas": "Wilmersdorf",   // Schaperstraße 24
  "berliner-festspiele-theatertreffen": "Wilmersdorf",
  // Expos
  "hamburger-bahnhof": "Mitte",                                // Invalidenstraße 50
  "neue-nationalgalerie": "Tiergarten",                        // Potsdamer Straße 50
  "kw-institute-for-contemporary-art": "Mitte",                // Auguststraße 69
  "c-o-berlin": "Charlottenburg",                              // Hardenbergstraße 22
  "berlinische-galerie": "Kreuzberg",                          // Alte Jakobstraße 124
  "fotografiska-berlin": "Mitte",                              // Oranienburger Straße 54
  "gropius-bau": "Kreuzberg",                                  // Niederkirchnerstraße 7
  // Cinémas
  "cinema-intimes": "Friedrichshain",                          // Niederbarnimstraße 15
  "cinema-lichtblick": "Prenzlauer Berg",                      // Kastanienallee 77
  "cinema-b-ware-ladenkino": "Friedrichshain",                 // Gärtnerstraße 19
  "cinema-babylon": "Mitte",                                   // Rosa-Luxemburg-Straße 30
  "cinema-kino-international": "Mitte",                        // Karl-Marx-Allee 33
  "staatsoper-unter-den-linden": "Mitte",
  "deutsche-oper-berlin": "Charlottenburg",
  "komische-oper-berlin": "Charlottenburg",
  "berliner-philharmoniker": "Tiergarten",
};
