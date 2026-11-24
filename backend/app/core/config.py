"""Application settings, loaded from environment variables / .env files."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BACKEND_DIR.parent

# backend/.env takes precedence over the project-root .env; real env vars win over both.
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")


def _list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # LLM (Groq)
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    groq_model: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    llm_temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.2"))

    # Embeddings (local HuggingFace sentence-transformers model)
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

    # Chunking / retrieval
    chunk_size: int = int(os.getenv("CHUNK_SIZE", "1000"))
    chunk_overlap: int = int(os.getenv("CHUNK_OVERLAP", "200"))
    top_k: int = int(os.getenv("TOP_K", "4"))

    # Transcript languages to try, in order of preference
    transcript_languages: list[str] = field(
        default_factory=lambda: _list("TRANSCRIPT_LANGUAGES", "en")
    )

    # Where FAISS indexes are saved (one sub-folder per video)
    vectorstore_dir: Path = Path(os.getenv("VECTORSTORE_DIR", str(BACKEND_DIR / "vectorstore")))

    # CORS: the extension calls the API from its service worker (chrome-extension://<id>)
    cors_origin_regex: str = os.getenv(
        "CORS_ORIGIN_REGEX", r"^(chrome-extension://.*|https://(www\.)?youtube\.com)$"
    )


settings = Settings()
