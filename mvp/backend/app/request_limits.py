"""Bound incoming bodies before multipart parsing can spool uploaded files."""
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


class RequestBodyLimit:
    def __init__(self, app, maximum: int):
        self.app = app
        self.maximum = maximum

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    length = int(value)
                except ValueError:
                    length = -1
                if length < 0:
                    return await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
                if length > self.maximum:
                    return await self.reject(scope, receive, send)

        size = 0
        response_started = False

        async def bounded_receive():
            nonlocal size
            message = await receive()
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > self.maximum:
                    raise HTTPException(413, "Request body exceeds the configured limit")
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, bounded_receive, tracked_send)
        except HTTPException as exc:
            if exc.status_code != 413 or response_started:
                raise
            await self.reject(scope, receive, send)

    async def reject(self, scope, receive, send):
        await JSONResponse({"detail": "Request body exceeds the configured limit"}, status_code=413)(scope, receive, send)
