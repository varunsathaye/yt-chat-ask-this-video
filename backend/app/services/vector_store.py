"""Chunking transcripts and managing one FAISS index per video."""

import shutil
import threading
from collections import defaultdict

from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document

from app.core.config import settings
from app.services.embeddings import get_embeddings
from app.services.transcript import Snippet, fetch_transcript, validate_video_id

_stores: dict[str, FAISS] = {}
_locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)
_locks_guard = threading.Lock()


def chunk_snippets(
    snippets: list[Snippet],
    video_id: str,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
) -> list[Document]:
    """Group transcript snippets into ~chunk_size-character documents.

    Chunks are built from whole snippets (rather than splitting raw text) so every
    chunk keeps the start/end timestamps of the part of the video it covers.
    """
    chunk_size = chunk_size or settings.chunk_size
    chunk_overlap = settings.chunk_overlap if chunk_overlap is None else chunk_overlap

    docs: list[Document] = []
    i, n = 0, len(snippets)
    while i < n:
        j, length, parts = i, 0, []
        while j < n and (not parts or length + len(snippets[j].text) + 1 <= chunk_size):
            parts.append(snippets[j].text)
            length += len(snippets[j].text) + 1
            j += 1

        last = snippets[j - 1]
        docs.append(
            Document(
                page_content=" ".join(parts),
                metadata={
                    "video_id": video_id,
                    "start": snippets[i].start,
                    "end": last.start + last.duration,
                },
            )
        )
        if j >= n:
            break

        # Step back over trailing snippets so consecutive chunks overlap,
        # always moving forward by at least one snippet.
        k, overlap = j, 0
        while k - 1 > i and overlap + len(snippets[k - 1].text) + 1 <= chunk_overlap:
            k -= 1
            overlap += len(snippets[k].text) + 1
        i = k

    return docs


def _lock_for(video_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks[video_id]


def get_vector_store(video_id: str, force_rebuild: bool = False) -> tuple[FAISS, bool]:
    """Return the FAISS index for a video, building it if needed.

    Returns (store, created) where `created` is True if the index was built now.
    Order of lookup: memory cache -> disk -> fetch transcript and embed.
    """
    validate_video_id(video_id)
    path = settings.vectorstore_dir / video_id

    with _lock_for(video_id):
        if force_rebuild:
            _stores.pop(video_id, None)
            shutil.rmtree(path, ignore_errors=True)

        if video_id in _stores:
            return _stores[video_id], False

        if (path / "index.faiss").exists():
            # Safe: these pickle files were written by this app (save_local below).
            store = FAISS.load_local(
                str(path), get_embeddings(), allow_dangerous_deserialization=True
            )
            _stores[video_id] = store
            return store, False

        docs = chunk_snippets(fetch_transcript(video_id), video_id)
        store = FAISS.from_documents(docs, get_embeddings())
        path.mkdir(parents=True, exist_ok=True)
        store.save_local(str(path))
        _stores[video_id] = store
        return store, True


def chunk_count(store: FAISS) -> int:
    return store.index.ntotal
