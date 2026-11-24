"""Request / response models for the API."""

from typing import Literal

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    video_id: str = Field(..., examples=["SwQhKFMxmDY"])
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list)


class Source(BaseModel):
    start: float
    end: float
    timestamp: str
    url: str
    text: str


class ChatResponse(BaseModel):
    answer: str
    sources: list[Source]


class IngestResponse(BaseModel):
    video_id: str
    chunks: int
    created: bool  # False if the index already existed (memory or disk)


class HealthResponse(BaseModel):
    status: str
    llm_configured: bool
