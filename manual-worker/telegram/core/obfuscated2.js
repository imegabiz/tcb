const subtle = globalThis.crypto.subtle;
const FRAME_TAG = {
  INTERMEDIATE_PADDED: 3722304989,
  INTERMEDIATE: 4008636142,
  ABRIDGED: 4025479151
};
function reverseSlice(bytes, start, end) {
  const len = end - start;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bytes[end - 1 - i];
  return out;
}
async function sha256(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}
function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
async function aesCtrCrypt(keyBytes, ivBytes, data) {
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
  const result = await subtle.encrypt({ name: "AES-CTR", counter: ivBytes, length: 128 }, key, data);
  return new Uint8Array(result);
}
async function deriveKeys(header64, secret) {
  let readKey = header64.slice(8, 40);
  const readIv = header64.slice(40, 56);
  let writeKey = reverseSlice(header64, 24, 56);
  const writeIv = reverseSlice(header64, 8, 24);
  if (secret) {
    readKey = await sha256(concatBytes(readKey, secret));
    writeKey = await sha256(concatBytes(writeKey, secret));
  }
  return { readKey, readIv, writeKey, writeIv };
}
async function serverHandshake(header64, secret = null) {
  if (header64.length !== 64) throw new RangeError("header must be exactly 64 bytes");
  const { readKey, readIv, writeKey, writeIv } = await deriveKeys(header64, secret);
  const decrypted = await aesCtrCrypt(readKey, readIv, header64);
  const dv = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.length);
  const tag = dv.getUint32(56, false);
  const targetDc = dv.getInt16(60, true);
  if (![FRAME_TAG.INTERMEDIATE_PADDED, FRAME_TAG.INTERMEDIATE, FRAME_TAG.ABRIDGED].includes(tag)) {
    throw new Error(`unrecognized obfuscation tag 0x${tag.toString(16)}`);
  }
  return { readKey, readIv, writeKey, writeIv, tag, targetDc };
}
async function buildClientHeader(targetDc, tag, secret = null, randomBytesFn = defaultRandomBytes) {
  let header;
  do {
    header = randomBytesFn(64);
  } while (header[0] === 239);
  const { readKey, readIv, writeKey, writeIv } = await deriveKeys(header, secret);
  const dv = new DataView(header.buffer);
  dv.setUint32(56, tag, false);
  dv.setInt16(60, targetDc, true);
  const ciphertextFull = await aesCtrCrypt(readKey, readIv, header);
  const wireBytes = header.slice();
  wireBytes.set(ciphertextFull.slice(56, 64), 56);
  return { wireBytes, readKey, readIv, writeKey, writeIv };
}
function defaultRandomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export {
  FRAME_TAG,
  aesCtrCrypt,
  buildClientHeader,
  serverHandshake
};
