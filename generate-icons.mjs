// Generate Android icons from logo.png using sharp
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.join(__dirname, 'public', 'logo.png');
const resDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res');

const sizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

const foregroundSizes = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432,
};

async function generate() {
  for (const [folder, size] of Object.entries(sizes)) {
    const outPath = path.join(resDir, folder, 'ic_launcher.png');
    await sharp(logoPath)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toFile(outPath);
    console.log(`Generated ${outPath} (${size}x${size})`);

    const roundPath = path.join(resDir, folder, 'ic_launcher_round.png');
    // Create circular icon
    const circleBuffer = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/></svg>`
    );
    await sharp(logoPath)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .composite([{ input: circleBuffer, blend: 'dest-in' }])
      .png()
      .toFile(roundPath);
    console.log(`Generated ${roundPath} (${size}x${size} round)`);
  }

  for (const [folder, size] of Object.entries(foregroundSizes)) {
    const fgPath = path.join(resDir, folder, 'ic_launcher_foreground.png');
    // Foreground is larger canvas with icon centered (72% of total)
    const iconSize = Math.round(size * 0.6);
    const icon = await sharp(logoPath)
      .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([{ input: icon, gravity: 'centre' }])
      .png()
      .toFile(fgPath);
    console.log(`Generated ${fgPath} (${size}x${size} foreground)`);
  }

  console.log('Done! All icons generated.');
}

generate().catch(console.error);
