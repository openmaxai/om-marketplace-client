import http from 'node:http';

// Fake storage emulator on 127.0.0.1. serve(path, ...responses) queues {status, body, headers} per path; requests are
// recorded with their headers.
export async function startFakeStorage() {
  const routes = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    const r = routes.get(req.url)?.shift() ?? { status: 404 };
    res.writeHead(r.status, r.headers ?? {});
    res.end(r.body ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    serve(path, ...responses) {
      routes.set(path, [...(routes.get(path) ?? []), ...responses]);
      return `${origin}${path}`;
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
