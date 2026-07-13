// DCP chunk decoder worker (perf opt #2). Fetches a .bin chunk, dequantises positions,
// computes vertex normals, and transfers the raw typed arrays back — so none of the
// fetch/parse/decode/normal cost lands on the main thread (no pan hitch, no big JSON string).
// Format matches transcode_bin.py: 40-byte header + u16 pos + u8 col [+u8 seed][+u8 kind] + idx.
self.onmessage = (e) => {
  const { id, url } = e.data;
  fetch(url).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(buf => {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x3143594E) throw new Error('bad magic');
    const flags = dv.getUint8(6);
    const i32 = flags & 1, hasSeed = flags & 2, hasKind = flags & 4;
    const nv = dv.getUint32(8, true), nt = dv.getUint32(12, true);
    const sc = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
    const of = [dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)];
    let o = 40;
    const q = new Uint16Array(buf, o, nv * 3); o += nv * 6;      // 40 is 2-aligned
    const pos = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) pos[i] = q[i] / 65535 * sc[i % 3] + of[i % 3];
    const col = new Uint8Array(buf.slice(o, o + nv * 3)); o += nv * 3;
    let seed = null, kind = null;
    if (hasSeed) { seed = new Uint8Array(buf.slice(o, o + nv)); o += nv; }
    if (hasKind) { kind = new Uint8Array(buf.slice(o, o + nv)); o += nv; }
    const idx = i32 ? new Uint32Array(buf.slice(o)) : new Uint16Array(buf.slice(o));
    // area-weighted vertex normals (matches THREE.computeVertexNormals)
    const nor = new Float32Array(nv * 3);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
      nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
      nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
    }
    for (let i = 0; i < nor.length; i += 3) {
      const x = nor[i], y = nor[i + 1], z = nor[i + 2], l = Math.hypot(x, y, z) || 1;
      nor[i] = x / l; nor[i + 1] = y / l; nor[i + 2] = z / l;
    }
    // M1b (plan-mobile-memory.md): ship normals as normalized Int8 — 12 → 3 B/vertex on
    // the transfer AND the GPU, imperceptible on the Lambert materials (same quantization
    // C2b shipped for the procedural city). Main thread wires normalized:true.
    const nor8 = new Int8Array(nv * 3);
    for (let i = 0; i < nor.length; i++) nor8[i] = Math.round(nor[i] * 127);
    const transfer = [pos.buffer, nor8.buffer, col.buffer, idx.buffer];
    if (seed) transfer.push(seed.buffer);
    if (kind) transfer.push(kind.buffer);
    self.postMessage({ id, ok: true, pos, nor: nor8, col, seed, kind, idx }, transfer);
  }).catch(err => self.postMessage({ id, ok: false, error: String(err && err.message || err) }));
};
