"""Fetching YouTube transcripts with youtube-transcript-api."""

import re
from dataclasses import dataclass

from youtube_transcript_api import (
    NoTranscriptFound,
    YouTubeTranscriptApi,
    YouTubeTranscriptApiException,
)

from app.core.config import settings

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class InvalidVideoIdError(ValueError):
    """The string is not a valid YouTube video ID."""


class TranscriptUnavailableError(RuntimeError):
    """No transcript could be fetched for the video."""


@dataclass(frozen=True)
class Snippet:
    text: str
    start: float  # seconds from the start of the video
    duration: float


def validate_video_id(video_id: str) -> str:
    # The ID is also used as a folder name on disk, so it must be strictly validated.
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise InvalidVideoIdError(f"Invalid YouTube video id: {video_id!r}")
    return video_id


def fetch_transcript(video_id: str, languages: list[str] | None = None) -> list[Snippet]:
    """Return the transcript of a video as a list of timed snippets.

    Tries the preferred languages first, then falls back to any available transcript.
    """
    validate_video_id(video_id)
    languages = languages or settings.transcript_languages
    api = YouTubeTranscriptApi()

    try:
        try:
            fetched = api.fetch(video_id, languages=languages)
        except NoTranscriptFound:
            # No transcript in the preferred languages: use whatever exists.
            transcript = next(iter(api.list(video_id)))
            fetched = transcript.fetch()
    except StopIteration:
        raise TranscriptUnavailableError(f"No transcripts exist for video {video_id}") from None
    except YouTubeTranscriptApiException as exc:
        raise TranscriptUnavailableError(
            f"Could not fetch transcript for video {video_id}: {type(exc).__name__}"
        ) from exc

    snippets = [
        Snippet(text=s.text.replace("\n", " ").strip(), start=s.start, duration=s.duration)
        for s in fetched
        if s.text.strip()
    ]
    if not snippets:
        raise TranscriptUnavailableError(f"Transcript for video {video_id} is empty")
    return snippets
