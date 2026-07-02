"""
Stream Handler — Flask SSE generator for camera streams

Bridges a CameraThread's SSE subscriber Queue with Flask's
stream_with_context so the frontend can consume frames and
inference results as Server-Sent Events.
"""
import json
from flask import stream_with_context, Response


def camera_sse_stream(camera_thread):
    """Return a Flask ``Response`` that yields SSE events while connected."""
    q = camera_thread.subscribe_sse()

    def generate():
        try:
            while True:
                try:
                    yield q.get(timeout=30)
                except Exception:
                    yield ": keepalive\n\n"
        finally:
            camera_thread.unsubscribe_sse(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            # The frontend may load this from a dedicated streaming port
            # (STREAM_PORT) distinct from the main API port, which browsers
            # treat as a separate origin — allow it, since this endpoint
            # carries no cookies/credentials.
            "Access-Control-Allow-Origin": "*",
        },
    )
