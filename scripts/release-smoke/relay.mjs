// #1369: the updater's real start probe needs the Worker's probe-only WebSocket echo.
// Node builtins only; this fixture accepts short, masked text/control frames, never runtime commands.
import { createHash } from "node:crypto";

export function attachProbeRelay(server, { instanceId, token }) {
	const sockets = new Set();
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://localhost");
		const key = req.headers["sec-websocket-key"];
		if (url.pathname !== `/v1/relay/${encodeURIComponent(instanceId)}/connect`
			|| url.searchParams.get("probe") !== "1" || url.searchParams.get("token") !== token
			|| req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" || typeof key !== "string") {
			socket.destroy(); return;
		}
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		sockets.add(socket);
		const timer = setTimeout(() => socket.destroy(), 30_000);
		timer.unref();
		socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
		socket.on("error", () => socket.destroy());
		const send = (opcode, data) => {
			const payload = Buffer.from(data);
			socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
		};
		send(1, "probe-ok");
		let pending = Buffer.alloc(0);
		const consume = (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 2) {
				const opcode = pending[0] & 0x0f;
				const length = pending[1] & 0x7f;
				// Real probes send one short text frame. Unsupported framing fails the probe, never passes it.
				if (!(pending[0] & 0x80) || (pending[0] & 0x70) || !(pending[1] & 0x80) || length > 125 || ![1, 8, 9, 10].includes(opcode)) { socket.destroy(); return; }
				if (pending.length < 6 + length) return;
				const mask = pending.subarray(2, 6);
				const payload = Buffer.from(pending.subarray(6, 6 + length));
				for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
				pending = pending.subarray(6 + length);
				if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
				if (opcode === 9) send(10, payload);
				if (opcode === 1) {
					const text = payload.toString("utf8");
					if (text.startsWith("rtt:") && text.length > 4 && length <= 120) send(1, `rtt-echo:${text.slice(4)}`);
				}
			}
		};
		socket.on("data", consume);
		if (head.length) consume(head);
	});
	return { close: () => { for (const socket of sockets) socket.destroy(); } };
}
