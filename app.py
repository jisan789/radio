from server import app as asgi_app

try:
    from a2wsgi import ASGIMiddleware
except ImportError:
    # ASGI app for hosts that start the project with uvicorn/gunicorn.
    app = asgi_app
else:
    # WSGI wrapper for cPanel/Passenger-style Python app panels.
    # HTTP routes will work through this. WebSockets still require ASGI hosting.
    app = ASGIMiddleware(asgi_app)

