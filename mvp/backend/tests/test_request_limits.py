import asyncio

import pytest
from fastapi import FastAPI, File, UploadFile
from fastapi.testclient import TestClient

from app.request_limits import RequestBodyLimit


def run_request(headers, chunks):
    received = []
    responses = []

    async def consumer(scope, receive, send):
        while True:
            message = await receive()
            received.append(message["body"])
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages = iter([
        {"type": "http.request", "body": chunk, "more_body": i < len(chunks) - 1}
        for i, chunk in enumerate(chunks)
    ])

    async def receive():
        return next(messages)

    async def send(message):
        responses.append(message)

    asyncio.run(RequestBodyLimit(consumer, maximum=32)(
        {"type": "http", "headers": headers}, receive, send,
    ))
    return responses[0]["status"], received


def test_declared_oversize_rejected_without_reading_body():
    assert run_request([(b"content-length", b"33")], [b"data"]) == (413, [])


@pytest.mark.parametrize("headers", [[], [(b"content-length", b"8")]])
def test_streaming_body_limit_cannot_be_bypassed_by_missing_or_small_header(headers):
    assert run_request(headers, [b"a" * 16, b"b" * 17]) == (413, [b"a" * 16])


def test_body_at_limit_accepted():
    assert run_request([], [b"a" * 16, b"b" * 16])[0] == 204


@pytest.mark.parametrize("length", [b"invalid", b"-1"])
def test_invalid_content_length_rejected(length):
    assert run_request([(b"content-length", length)], [b"data"]) == (400, [])


@pytest.mark.parametrize("headers", [{}, {"Content-Length": "8"}])
def test_multipart_stream_exceeding_limit_returns_413_before_endpoint(headers):
    app = FastAPI()
    app.add_middleware(RequestBodyLimit, maximum=1024)

    @app.post("/upload")
    async def upload(file: UploadFile = File(...)):
        pytest.fail("Oversize multipart bodies must never reach the endpoint")

    prefix = b'--test\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\n\r\n'
    body = prefix + b"a" * 1024 + b"\r\n--test--\r\n"
    with TestClient(app) as client:
        response = client.post("/upload", content=iter([body[:512], body[512:]]),
                               headers={"Content-Type": "multipart/form-data; boundary=test", **headers})
    assert response.status_code == 413
