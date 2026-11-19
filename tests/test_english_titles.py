from src.models import english_title


def test_german_with_english_in_brackets():
    assert english_title("Die Wildente (The Wild Duck)") == ("The Wild Duck", "Die Wildente")
    assert english_title("Der Liebling (Darling)") == ("Darling", "Der Liebling")


def test_english_first():
    assert english_title("Twelfth Night (Was ihr wollt)") == ("Twelfth Night", "Was ihr wollt")


def test_working_title_and_known_operas():
    assert english_title("The Cold Reminder (AT)") == ("The Cold Reminder", None)
    assert english_title("Die Zauberflöte") == ("The Magic Flute", "Die Zauberflöte")
    assert english_title("Hamlet") == ("Hamlet", None)
