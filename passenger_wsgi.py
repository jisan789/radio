from a2wsgi import ASGIMiddleware
from server import app as fastapi_app

application = ASGIMiddleware(fastapi_app)
