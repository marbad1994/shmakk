// Throwaway mock of the shmakk API, only for eyeballing layout in the browser.
const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/conversations')) return res.end('[]');
  if (req.url.startsWith('/api/projects')) return res.end('[]');
  if (req.url.startsWith('/api/sessions')) return res.end('[]');
  res.end('{}');
});

server.listen(5200, '127.0.0.1', () => console.log('mock api on 5200'));
