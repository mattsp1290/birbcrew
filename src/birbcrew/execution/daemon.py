import asyncio
import json
from pathlib import Path

from wsproto import ConnectionType, WSConnection
from wsproto.events import AcceptConnection, CloseConnection, Ping, Request, TextMessage


class Daemon:
    """An owned client of the existing managed daemon. Notifications are discarded."""

    def __init__(self, binary: Path):
        self.binary = binary
        self.wire = WSConnection(ConnectionType.CLIENT)
        self.sequence = 0
        self.partial = ""
        self.process = None

    async def __aenter__(self):
        try:
            return await self.connect()
        except BaseException:
            await self.__aexit__()
            raise

    async def connect(self):
        self.process = await asyncio.create_subprocess_exec(
            str(self.binary),
            "app-server",
            "proxy",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await self.send_event(Request(host="localhost", target="/"))
        async with asyncio.timeout(15):
            while True:
                self.wire.receive_data(await self.process.stdout.read(65536))
                if any(isinstance(event, AcceptConnection) for event in self.wire.events()):
                    break
        await self.call(
            "initialize",
            {
                "clientInfo": {"name": "birbcrew_execution", "version": "1.0.0"},
                "capabilities": {
                    "optOutNotificationMethods": [
                        "item/reasoning/summaryTextDelta",
                        "item/reasoning/textDelta",
                        "item/reasoning/summaryPartAdded",
                    ]
                },
            },
        )
        await self.send({"method": "initialized"})
        return self

    async def send_event(self, event):
        self.process.stdin.write(self.wire.send(event))
        await self.process.stdin.drain()

    async def send(self, value):
        await self.send_event(TextMessage(data=json.dumps(value)))

    async def call(self, method: str, params: dict):
        self.sequence += 1
        identity = self.sequence
        await self.send({"id": identity, "method": method, "params": params})
        async with asyncio.timeout(45):
            while True:
                data = await self.process.stdout.read(65536)
                if not data:
                    raise ConnectionError("daemon_proxy_closed")
                self.wire.receive_data(data)
                for event in self.wire.events():
                    if isinstance(event, Ping):
                        await self.send_event(event.response())
                    elif isinstance(event, CloseConnection):
                        raise ConnectionError("daemon_connection_closed")
                    elif isinstance(event, TextMessage):
                        self.partial += event.data
                        if len(self.partial) > 8 * 1024 * 1024:
                            raise ValueError("daemon_message_too_large")
                        if event.message_finished:
                            message = json.loads(self.partial)
                            self.partial = ""
                            if message.get("id") == identity:
                                if "error" in message:
                                    raise RuntimeError("daemon_rpc_rejected")
                                return message["result"]

    async def __aexit__(self, *_):
        if self.process:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except TimeoutError:
                self.process.terminate()
                await self.process.wait()
