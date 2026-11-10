-- Photo de profil (data URL JPEG 128 px, redimensionnée dans la page), affichée à la place du prénom.
ALTER TABLE users ADD COLUMN photo TEXT;
