/** 极简 SSE 广播中心：投影仪和手机都通过它实时收到同一份房间状态 */
export function createHub() {
  const clients = new Set();

  const write = (client, type, data) => {
    try {
      client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(client);
    }
  };

  const keepalive = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 20000);
  keepalive.unref?.();

  return {
    add(req, res, meta = {}) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { res, meta };
      clients.add(client);
      req.on('close', () => clients.delete(client));
      return client;
    },
    send(client, type, data) {
      if (client) write(client, type, data);
    },
    broadcast(type, data) {
      for (const client of clients) write(client, type, data);
    },
    get count() {
      return clients.size;
    },
  };
}
