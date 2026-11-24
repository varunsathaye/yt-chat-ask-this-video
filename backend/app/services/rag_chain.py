"""Retrieval-augmented answering over a video's transcript."""

from dataclasses import dataclass
from functools import lru_cache

from langchain_core.documents import Document
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_groq import ChatGroq

from app.core.config import settings
from app.services.vector_store import get_vector_store

MAX_HISTORY_MESSAGES = 10

SYSTEM_PROMPT = """You are a helpful assistant answering questions about a YouTube video.
Answer using ONLY the transcript excerpts below. If the answer is not in the excerpts,
say that the video doesn't seem to cover it. Be concise. When useful, cite the moment in
the video using the timestamps shown, e.g. [12:34].
Your answer is shown in a narrow chat panel: write short paragraphs or simple bullet lists,
and never use tables or headings.

Transcript excerpts:
{context}"""

PROMPT = ChatPromptTemplate.from_messages(
    [
        ("system", SYSTEM_PROMPT),
        MessagesPlaceholder("history"),
        ("human", "{question}"),
    ]
)


class LLMNotConfiguredError(RuntimeError):
    """GROQ_API_KEY is missing."""


@dataclass(frozen=True)
class RagAnswer:
    answer: str
    sources: list[Document]


def format_timestamp(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def format_context(docs: list[Document]) -> str:
    return "\n\n".join(
        f"[{format_timestamp(d.metadata['start'])}] {d.page_content}" for d in docs
    )


@lru_cache(maxsize=1)
def get_llm() -> ChatGroq:
    if not settings.groq_api_key:
        raise LLMNotConfiguredError("GROQ_API_KEY is not set; add it to your .env file")
    return ChatGroq(
        model=settings.groq_model,
        temperature=settings.llm_temperature,
        api_key=settings.groq_api_key,
    )


def to_messages(history: list[tuple[str, str]]) -> list[BaseMessage]:
    """Convert (role, content) pairs into LangChain messages, keeping the most recent ones."""
    messages: list[BaseMessage] = []
    for role, content in history[-MAX_HISTORY_MESSAGES:]:
        messages.append(HumanMessage(content) if role == "user" else AIMessage(content))
    return messages


def answer_question(
    video_id: str, question: str, history: list[tuple[str, str]] | None = None
) -> RagAnswer:
    store, _ = get_vector_store(video_id)
    docs = store.similarity_search(question, k=settings.top_k)
    docs.sort(key=lambda d: d.metadata["start"])  # present excerpts in video order

    chain = PROMPT | get_llm() | StrOutputParser()
    answer = chain.invoke(
        {
            "context": format_context(docs),
            "history": to_messages(history or []),
            "question": question,
        }
    )
    return RagAnswer(answer=answer.strip(), sources=docs)
