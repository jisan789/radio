import os
import json
import socket
import logging
from typing import Dict, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("walkie-talkie")

app = FastAPI(title="Web Walkie-Talkie")

@app.middleware("http")
async def add_browser_permission_headers(request, call_next):
    response = await call_next(request)
    response.headers["Permissions-Policy"] = "microphone=(self)"
    return response

def get_lan_ip() -> str:
    """Retrieve the primary network IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually establish connection, just routes socket
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

class Peer:
    def __init__(self, client_id: str, username: str, websocket: WebSocket):
        self.client_id = client_id
        self.username = username
        self.websocket = websocket

class Room:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.peers: Dict[str, Peer] = {}
        self.active_speaker_id: Optional[str] = None

    async def broadcast(self, message: dict, exclude_client_id: Optional[str] = None):
        payload = json.dumps(message)
        for client_id, peer in list(self.peers.items()):
            if exclude_client_id and client_id == exclude_client_id:
                continue
            try:
                await peer.websocket.send_text(payload)
            except Exception as e:
                logger.warning(f"Error sending message to {client_id}: {e}")

    def get_peer_list(self):
        return [
            {"client_id": peer.client_id, "username": peer.username}
            for peer in self.peers.values()
        ]

class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}

    def get_or_create_room(self, room_id: str) -> Room:
        if room_id not in self.rooms:
            self.rooms[room_id] = Room(room_id)
        return self.rooms[room_id]

    async def add_peer(self, room_id: str, client_id: str, username: str, websocket: WebSocket) -> Room:
        room = self.get_or_create_room(room_id)
        peer = Peer(client_id, username, websocket)
        room.peers[client_id] = peer
        logger.info(f"User '{username}' ({client_id}) joined room '{room_id}'. Total peers: {len(room.peers)}")

        # Notify existing peers that a new peer joined
        await room.broadcast({
            "type": "peer_joined",
            "peer": {"client_id": client_id, "username": username},
            "active_speaker_id": room.active_speaker_id,
            "speaker_name": room.peers[room.active_speaker_id].username if room.active_speaker_id and room.active_speaker_id in room.peers else None
        }, exclude_client_id=client_id)

        # Send existing peer list and room state to the newly joined peer
        await websocket.send_text(json.dumps({
            "type": "room_state",
            "room_id": room_id,
            "peers": room.get_peer_list(),
            "active_speaker_id": room.active_speaker_id,
            "speaker_name": room.peers[room.active_speaker_id].username if room.active_speaker_id and room.active_speaker_id in room.peers else None
        }))
        return room

    async def remove_peer(self, room_id: str, client_id: str):
        if room_id not in self.rooms:
            return
        room = self.rooms[room_id]
        if client_id in room.peers:
            username = room.peers[client_id].username
            del room.peers[client_id]
            logger.info(f"User '{username}' ({client_id}) left room '{room_id}'.")

            # Release floor if speaker left
            if room.active_speaker_id == client_id:
                room.active_speaker_id = None
                await room.broadcast({
                    "type": "floor_released",
                    "client_id": client_id
                })

            await room.broadcast({
                "type": "peer_left",
                "client_id": client_id,
                "username": username
            })

        if len(room.peers) == 0:
            del self.rooms[room_id]
            logger.info(f"Room '{room_id}' is empty and closed.")

manager = RoomManager()

# WebSocket endpoint for signaling and floor arbitration
@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str, username: str = "Operator"):
    await websocket.accept()
    room = await manager.add_peer(room_id, client_id, username, websocket)

    try:
        while True:
            text = await websocket.receive_text()
            data = json.loads(text)
            msg_type = data.get("type")

            if msg_type == "talk_request":
                # Push-To-Talk: Request to speak
                if room.active_speaker_id is None:
                    room.active_speaker_id = client_id
                    await room.broadcast({
                        "type": "floor_granted",
                        "speaker_id": client_id,
                        "speaker_name": username
                    })
                else:
                    # Floor is already taken
                    await websocket.send_text(json.dumps({
                        "type": "floor_denied",
                        "active_speaker_id": room.active_speaker_id,
                        "speaker_name": room.peers[room.active_speaker_id].username if room.active_speaker_id in room.peers else "Unknown"
                    }))

            elif msg_type == "talk_release":
                # Push-To-Talk: Release floor
                if room.active_speaker_id == client_id:
                    room.active_speaker_id = None
                    await room.broadcast({
                        "type": "floor_released",
                        "speaker_id": client_id,
                        "speaker_name": username
                    })

            elif msg_type in ["signal_offer", "signal_answer", "signal_candidate"]:
                # WebRTC Signaling pass-through: route to target peer
                target_id = data.get("target_id")
                if target_id and target_id in room.peers:
                    forward_payload = {
                        "type": msg_type,
                        "from_id": client_id,
                        "username": username,
                        "payload": data.get("payload")
                    }
                    await room.peers[target_id].websocket.send_text(json.dumps(forward_payload))

    except WebSocketDisconnect:
        await manager.remove_peer(room_id, client_id)
    except Exception as e:
        logger.error(f"WebSocket error for peer {client_id}: {e}")
        await manager.remove_peer(room_id, client_id)

# Serve static directory
static_dir = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir, exist_ok=True)

app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
async def get_index():
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "Web Walkie-Talkie backend online. Frontend files loading..."}

@app.get("/api/info")
async def get_info():
    lan_ip = get_lan_ip()
    return {
        "status": "online",
        "app_url": "",
        "lan_ip": lan_ip,
        "lan_url": f"http://{lan_ip}:8000"
    }

@app.get("/api/health")
async def get_health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    import argparse

    default_port = int(os.environ.get("PORT", 8000))
    parser = argparse.ArgumentParser(description="Web Walkie-Talkie Server")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind (default: {default_port})")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host interface (default: 0.0.0.0)")
    args = parser.parse_args()

    lan_ip = get_lan_ip()
    banner = f"""
========================================================================
             [RADIO] WEB WALKIE-TALKIE SERVER ONLINE [RADIO]
========================================================================
[1] Network:
    -> http://{lan_ip}:{args.port}
========================================================================
"""
    print(banner)
    uvicorn.run("server:app", host=args.host, port=args.port, reload=False)
