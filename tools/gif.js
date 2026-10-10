// Minimal animated GIF writer: small fixed palette, plays once (no loop), and each frame
// repaints one rectangle on top of the previous frame.

// Standard GIF LZW. The dictionary maps (code for a run of pixels, next pixel) to a new code;
// with at most 8 colours that pair fits a small flat table instead of a hash map.
function compress(pixels, colourBits) {
  const clear = 1 << colourBits;
  const end = clear + 1;
  const table = new Int16Array(4096 << colourBits); // 0 = no entry (real codes start above `end`)
  const out = [];
  let buffer = 0;
  let bits = 0;
  let codeBits = colourBits + 1;
  let nextCode = end + 1;

  const put = (code) => {
    buffer |= code << bits;
    bits += codeBits;
    while (bits >= 8) {
      out.push(buffer & 255);
      buffer >>= 8;
      bits -= 8;
    }
  };

  put(clear);
  let run = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const key = (run << colourBits) | pixels[i];
    if (table[key]) {
      run = table[key];
      continue;
    }
    put(run);
    if (nextCode === 4096) {
      put(clear);
      table.fill(0);
      codeBits = colourBits + 1;
      nextCode = end + 1;
    } else {
      if (nextCode >= 1 << codeBits) codeBits++;
      table[key] = nextCode++;
    }
    run = pixels[i];
  }
  put(run);
  put(end);
  if (bits) out.push(buffer & 255);
  return out;
}

// palette: 4 or 8 [r, g, b] colours. Pixels passed to addFrame are indexes into it.
export function createGif(width, height, palette) {
  const colourBits = Math.log2(palette.length);
  const bytes = [];
  const u16 = (v) => bytes.push(v & 255, v >> 8);

  bytes.push(...[..."GIF89a"].map((c) => c.charCodeAt(0)));
  u16(width);
  u16(height);
  bytes.push(0x80 | ((colourBits - 1) << 4) | (colourBits - 1), 0, 0); // global colour table, background index 0
  bytes.push(...palette.flat());

  return {
    addFrame(x, y, w, h, pixels, delayCentiseconds) {
      bytes.push(0x21, 0xf9, 4, 0x04); // graphic control: keep this frame when drawing the next
      u16(delayCentiseconds);
      bytes.push(0, 0);
      bytes.push(0x2c); // image descriptor
      u16(x);
      u16(y);
      u16(w);
      u16(h);
      bytes.push(0, colourBits);
      const data = compress(pixels, colourBits);
      for (let i = 0; i < data.length; i += 255) {
        const block = data.slice(i, i + 255);
        bytes.push(block.length, ...block);
      }
      bytes.push(0);
    },
    finish() {
      bytes.push(0x3b);
      return new Uint8Array(bytes);
    },
  };
}
