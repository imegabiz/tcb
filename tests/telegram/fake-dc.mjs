import net from 'node:net';

const port = Number(process.argv[2] || 21301);
const server = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    const out = Buffer.alloc(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] ^ 0xa5;
    const third = Math.max(1, Math.floor(out.length / 3));
    const pieces = [out.subarray(0, third), out.subarray(third, third * 2), out.subarray(third * 2)].filter((p) => p.length);
    let i = 0;
    const next = () => { if (i < pieces.length) { sock.write(pieces[i++]); setImmediate(next); } };
    next();
  });
});
server.listen(port, () => console.log('fake dc on', port));
