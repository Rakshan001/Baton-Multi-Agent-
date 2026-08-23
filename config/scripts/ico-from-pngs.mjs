// Pack PNG buffers into a Windows .ico (Vista+ PNG entries).
// Adapted from the orcabaton approach — never import that repo.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX = 256;

export function pngDimensions(png) {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function dimByte(v) {
  return v === MAX ? 0 : v;
}

export function icoFromPngs(pngs) {
  if (pngs.length === 0) throw new Error('an .ico needs at least one image');
  const images = pngs.map((png) => ({ png, ...pngDimensions(png) }));
  for (const image of images) {
    if (image.width > MAX || image.height > MAX) {
      throw new Error(`${image.width}x${image.height} exceeds .ico max ${MAX}`);
    }
  }
  if (!images.some((i) => i.width === MAX)) {
    throw new Error(`an application .ico needs a ${MAX}px entry`);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  for (const [i, image] of images.entries()) {
    const at = 16 * i;
    directory.writeUInt8(dimByte(image.width), at);
    directory.writeUInt8(dimByte(image.height), at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  }
  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}
