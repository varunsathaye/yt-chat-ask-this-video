"""Offline tests: no network calls, no model downloads.

Run from the backend/ folder:  python -m pytest
"""

import pytest
from fastapi.testclient import TestClient
from langchain_core.documents import Document

from app.api import routes
from app.main import app
from app.services.rag_chain import RagAnswer, format_timestamp, to_messages
from app.services.transcript import InvalidVideoIdError, Snippet, validate_video_id
from app.services.vector_store import chunk_snippets

client = TestClient(app)


def make_snippets(n: int, text: str = "word " * 9) -> list[Snippet]:
    return [Snippet(text=text.strip(), start=i * 2.0, duration=2.0) for i in range(n)]


# --- transcript ---------------------------------------------------------------

@pytest.mark.parametrize("vid", ["SwQhKFMxmDY", "a-b_c-d_e-f"])
def test_valid_video_ids(vid):
    assert validate_video_id(vid) == vid


@pytest.mark.parametrize("vid", ["", "short", "../../etc/pa", "SwQhKFMxmDY1", "SwQhKF/xmDY"])
def test_invalid_video_ids(vid):
    with pytest.raises(InvalidVideoIdError):
        validate_video_id(vid)


# --- chunking -----------------------------------------------------------------

def test_chunks_respect_size_and_cover_everything():
    snippets = make_snippets(100)  # each snippet is 44 chars
    docs = chunk_snippets(snippets, "SwQhKFMxmDY", chunk_size=200, chunk_overlap=50)

    assert len(docs) > 1
    assert all(len(d.page_content) <= 200 for d in docs)
    assert docs[0].metadata["start"] == 0.0
    assert docs[-1].metadata["end"] == snippets[-1].start + snippets[-1].duration
    # chunks overlap / are contiguous: each starts no later than where the previous ended
    for prev, cur in zip(docs, docs[1:]):
        assert prev.metadata["start"] < cur.metadata["start"] < prev.metadata["end"] + 1e-9


def test_chunking_always_makes_progress_with_huge_overlap():
    docs = chunk_snippets(make_snippets(20), "SwQhKFMxmDY", chunk_size=100, chunk_overlap=10_000)
    starts = [d.metadata["start"] for d in docs]
    assert starts == sorted(set(starts))


def test_oversized_snippet_becomes_its_own_chunk():
    snippets = [Snippet("x" * 500, 0, 1), Snippet("short", 1, 1)]
    docs = chunk_snippets(snippets, "SwQhKFMxmDY", chunk_size=100, chunk_overlap=0)
    assert [d.page_content for d in docs] == ["x" * 500, "short"]


# --- rag helpers --------------------------------------------------------------

@pytest.mark.parametrize("secs,expected", [(0, "0:00"), (65.9, "1:05"), (3725, "1:02:05")])
def test_format_timestamp(secs, expected):
    assert format_timestamp(secs) == expected


def test_history_is_truncated_and_typed():
    history = [("user" if i % 2 == 0 else "assistant", str(i)) for i in range(30)]
    msgs = to_messages(history)
    assert len(msgs) == 10
    assert msgs[-1].content == "29" and msgs[-1].type == "ai"


# --- API (services mocked) ----------------------------------------------------

def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_chat_endpoint(monkeypatch):
    doc = Document("hello world", metadata={"start": 75.0, "end": 80.0, "video_id": "SwQhKFMxmDY"})
    captured = {}

    def fake_answer(video_id, question, history):
        captured.update(video_id=video_id, question=question, history=history)
        return RagAnswer(answer="It says hello [1:15].", sources=[doc])

    monkeypatch.setattr(routes, "answer_question", fake_answer)
    r = client.post(
        "/chat",
        json={
            "video_id": "SwQhKFMxmDY",
            "question": "What does it say?",
            "history": [{"role": "user", "content": "hi"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "It says hello [1:15]."
    assert body["sources"][0]["timestamp"] == "1:15"
    assert body["sources"][0]["url"].endswith("v=SwQhKFMxmDY&t=75s")
    assert captured["history"] == [("user", "hi")]


def test_invalid_video_id_returns_422():
    r = client.post("/videos/not-valid/ingest")
    assert r.status_code == 422
