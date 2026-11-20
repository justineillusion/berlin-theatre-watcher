from src.cinema.tags import festival_from_text, festival_line


def test_cannes_with_prize():
    intro = ("Anatomy of a Fall is a 2023 French legal drama film. The film premiered at the 76th Cannes Film Festival on 21 May 2023, "
             "where it won the Palme d'Or.")
    f = festival_from_text(intro, 2023)
    assert f == {"fest": "Cannes", "year": 2023, "prize": "Palme d'or"}
    assert festival_line(f, "fr") == "Cannes 2023 · Palme d'or" and festival_line(f, "en") == "Cannes 2023 · Palme d'Or"


def test_prize_in_another_sentence_and_berlinale():
    intro = ("Dahomey is a 2024 documentary film. It premiered in competition at the 74th Berlin International Film Festival. "
             "It won the Golden Bear.")
    assert festival_line(festival_from_text(intro, 2024), "en") == "Berlinale 2024 · Golden Bear"


def test_no_festival_context():
    assert festival_from_text("A film shot in Cannes about a family.", 2020) is None


def test_genres_from_wikipedia_first_sentence():
    from src.cinema.tags import genres_from_intro
    assert genres_from_intro("Sentimental Value is a 2025 Norwegian comedy-drama film directed by Joachim Trier. It premiered at Cannes.") == ["comedy"]
    assert genres_from_intro("Block 10 is a 2025 German psychological thriller film by X.") == ["thriller"]
    assert genres_from_intro("Leica is a 2024 German documentary film about the camera.") == ["doc"]
    assert genres_from_intro("The Brutalist is a 2024 epic period drama film.") == ["history", "drama"]
    assert genres_from_intro("Berlin is the capital of Germany.") == []
