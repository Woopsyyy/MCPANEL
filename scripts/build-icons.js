const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, '../assets/logo.png');
const icoPath = path.join(__dirname, '../assets/logo.ico');

if (fs.existsSync(pngPath)) {
  const pngBuf = fs.readFileSync(pngPath);
  
  // ICO file header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: Icon (1)
  header.writeUInt16LE(1, 4); // Number of images: 1
  
  // Icon directory entry: 16 bytes
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // Width: 256 (represented as 0)
  entry.writeUInt8(0, 1); // Height: 256 (represented as 0)
  entry.writeUInt8(0, 2); // Color count: 0 (no palette)
  entry.writeUInt8(0, 3); // Reserved
  entry.writeUInt16LE(1, 4); // Color planes: 1
  entry.writeUInt16LE(32, 6); // Bits per pixel: 32
  entry.writeUInt32LE(pngBuf.length, 8); // Size of image data
  entry.writeUInt32LE(22, 12); // Offset to image data (header size 6 + entry size 16 = 22)
  
  const icoBuf = Buffer.concat([header, entry, pngBuf]);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('Successfully created assets/logo.ico');
} else {
  console.error('PNG logo not found at ' + pngPath);
}
