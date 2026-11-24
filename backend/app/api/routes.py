"""HTTP endpoints used by the Chrome extension."""

from fastapi import APIRouter

from app.core.config import settings
from app.schemas import ChatRequest, ChatResponse, HealthResponse, IngestResponse, Source
from app.services.rag_chain import answer_question, format_timestamp
from app.services.vector_store import chunk_count, get_vector_store

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", llm_configured=bool(settings.groq_api_key))


# Plain `def` endpoints run in FastAPI's thread pool, so blocking work
# (transcript download, embedding, LLM call) doesn't stall the event loop.
@router.post("/videos/{video_id}/ingest", response_model=IngestResponse)
def ingest(video_id: str, force: bool = False) -> IngestResponse:
    """Fetch, chunk and embed a video's transcript. Call this when a video page opens."""
    store, created = get_vector_store(video_id, force_rebuild=force)
    return IngestResponse(video_id=video_id, chunks=chunk_count(store), created=created)


@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    """Answer a question about a video. Ingests the video first if needed."""
    result = answer_question(
        req.video_id,
        req.question,
        [(m.role, m.content) for m in req.history],
    )
    return ChatResponse(
        answer=result.answer,
        sources=[
            Source(
                start=d.metadata["start"],
                end=d.metadata["end"],
                timestamp=format_timestamp(d.metadata["start"]),
                url=f"https://www.youtube.com/watch?v={req.video_id}&t={int(d.metadata['start'])}s",
                text=d.page_content,
            )
            for d in result.sources
        ],
    )
