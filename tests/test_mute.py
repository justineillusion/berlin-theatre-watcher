"""Test hors-ligne du « 🔕 Ne plus suivre » (aucun appel réseau).

    ./.venv/bin/python -m tests.test_mute      (ou pytest si installé)
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from src import mute
from src.models import Show
from src.notify import format_digest

CHAT = "4242"


class FakeTelegram:
    def __init__(self, updates):
        self.updates = updates
        self.calls = []

    def __call__(self, token, method, payload, timeout=30.0):
        self.calls.append((method, payload))
        if method == "getUpdates":
            off = payload.get("offset") or 0
            return {"ok": True, "result": [u for u in self.updates if u["update_id"] >= off]}
        if method == "answerCallbackQuery":
            raise RuntimeError("Bad Request: query is too old")   # callback périmé
        return {"ok": True, "result": {}}

    def methods(self, name):
        return [p for m, p in self.calls if m == name]


def _cb(uid, data, text="🎭 Hedda Gabler\n📍 Schaubühne\n🗓 …", chat=CHAT, markup=None):
    msg = {"message_id": 100 + uid, "chat": {"id": int(chat), "type": "private"}, "text": text}
    if markup:
        msg["reply_markup"] = markup
    return {"update_id": uid, "callback_query": {"id": f"cb{uid}", "from": {"id": int(chat)},
                                                 "data": data, "message": msg}}


def _msg(uid, text, chat=CHAT):
    return {"update_id": uid, "message": {"message_id": 500 + uid, "chat": {"id": int(chat)}, "text": text}}


def _setup(tmp: Path, updates, initial=None):
    mute.MUTED_PATH = tmp / "muted.json"
    if initial is not None:
        mute.MUTED_PATH.write_text(json.dumps(initial))
    fake = FakeTelegram(updates)
    mute._call = fake
    return fake


hedda = Show(theater="Schaubühne", title="Hedda Gabler")
expo = Show(theater="KW", title="Some Expo", kind="expo")
other = Show(theater="Volksbühne", title="Faust")
H, E = mute.mute_id(hedda), mute.mute_id(expo)


def test_keyboard_fits_callback_limit():
    kb = mute.mute_keyboard(hedda)
    data = kb["inline_keyboard"][0][0]["callback_data"]
    assert data == f"mute:{H}" and len(data.encode()) <= 64
    assert mute.mute_id(Show(theater="Schaubühne", title="  HEDDA gabler ")) == H   # stable


def test_scan_sync_mutes_edits_and_persists():
    with tempfile.TemporaryDirectory() as d:
        fake = _setup(Path(d), [
            _cb(10, f"mute:{H}"),
            _cb(11, f"mute:{E}", text="🖼 Some Expo\n📍 KW Institute"),
            _cb(12, f"mute:{H}"),                         # double clic : idempotent
            _cb(13, f"mute:{mute.key_id('X|y')}", chat="999"),   # autre chat : ignoré
            _msg(14, "/muets"),
        ])
        state = mute.sync("TOKEN", CHAT)
        assert set(state["muted"]) == {H, E}
        assert state["muted"][H]["title"] == "Hedda Gabler"
        assert state["muted"][H]["venue"] == "Schaubühne"
        assert state["muted"][E]["title"] == "Some Expo"
        assert state["offset"] == 15
        saved = json.loads(mute.MUTED_PATH.read_text())
        assert saved["offset"] == 15 and set(saved["muted"]) == {H, E}
        # original message switched to the « Réactiver » button
        edits = fake.methods("editMessageReplyMarkup")
        assert edits[0]["message_id"] == 110
        assert edits[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"unmute:{H}"
        sends = fake.methods("sendMessage")
        assert "Hedda Gabler" in sends[0]["text"] and "Some Expo" in sends[0]["text"]
        listing = sends[1]
        assert len(listing["reply_markup"]["inline_keyboard"]) == 2
        # filtering for scan / digest
        assert mute.filter_muted([hedda, expo, other], state) == [other]
        assert "Hedda" not in "".join(format_digest(mute.filter_muted([hedda, other], state)))

        # next run: getUpdates uses the persisted offset -> nothing new
        fake2 = _setup(Path(d), fake.updates)
        state2 = mute.sync("TOKEN", CHAT)
        assert fake2.methods("getUpdates")[0]["offset"] == 15
        assert set(state2["muted"]) == {H, E} and not fake2.methods("sendMessage")


def test_unmute_from_notification_and_from_list():
    with tempfile.TemporaryDirectory() as d:
        initial = {"offset": 20, "muted": {H: {"title": "Hedda Gabler", "venue": "", "at": ""},
                                           E: {"title": "Some Expo", "venue": "", "at": ""}}}
        list_markup = mute._list_keyboard(initial["muted"])
        fake = _setup(Path(d), [
            _cb(20, f"unmute:{H}"),
            _cb(21, f"unl:{E}", text="🔕 Pièces masquées (2)", markup=list_markup),
        ], initial)
        state = mute.sync("TOKEN", CHAT)
        assert state["muted"] == {} and state["offset"] == 22
        e1, e2 = fake.methods("editMessageReplyMarkup")
        assert e1["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"mute:{H}"
        assert [r[0]["callback_data"] for r in e2["reply_markup"]["inline_keyboard"]] == [f"unl:{H}"]


def test_digest_is_read_only():
    with tempfile.TemporaryDirectory() as d:
        fake = _setup(Path(d), [_cb(30, f"mute:{H}"), _msg(31, "/muets")], {"offset": 30, "muted": {}})
        state = mute.sync("TOKEN", CHAT, read_only=True)
        assert H in state["muted"]                       # appliqué en mémoire
        assert [m for m, _ in fake.calls] == ["getUpdates"]   # aucun autre appel
        assert json.loads(mute.MUTED_PATH.read_text()) == {"offset": 30, "muted": {}}


def test_network_failure_keeps_list():
    with tempfile.TemporaryDirectory() as d:
        _setup(Path(d), [], {"offset": 5, "muted": {H: {"title": "Hedda Gabler"}}})

        def boom(*a, **k):
            raise RuntimeError("Conflict: can't use getUpdates while webhook is active")
        mute._call = boom
        state = mute.sync("TOKEN", CHAT)
        assert H in state["muted"] and state["offset"] == 5


def test_noop_in_multi_mode():
    import os
    with tempfile.TemporaryDirectory() as d:
        fake = _setup(Path(d), [_cb(40, f"mute:{H}")], {"offset": 40, "muted": {}})
        os.environ["BOT_API_URL"] = "https://worker.example"
        try:
            state = mute.sync("TOKEN", CHAT)
        finally:
            del os.environ["BOT_API_URL"]
        assert fake.calls == [] and state == {"offset": 40, "muted": {}}


if __name__ == "__main__":
    original_call, original_path = mute._call, mute.MUTED_PATH
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            finally:
                mute._call, mute.MUTED_PATH = original_call, original_path
            print(f"ok  {name}")
    print("Tous les tests passent.")
