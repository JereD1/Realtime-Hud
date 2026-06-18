const DEFAULT_DETECTOR_SETTINGS = {
  playerCount: 5,
  saturationThreshold: 0.2,
  contrastThreshold: 42,
  fadeScoreThreshold: 0.62,
  sampleInset: 0.12,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;

  if (max === min) return { hue: 0, saturation: 0, lightness };

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;

  if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;

  return { hue: hue / 6, saturation, lightness };
}

function buildCardRegions(selection, playerCount = DEFAULT_DETECTOR_SETTINGS.playerCount) {
  const cardWidth = selection.width / playerCount;
  return Array.from({ length: playerCount }, (_, index) => ({
    id: index + 1,
    x: selection.x + cardWidth * index,
    y: selection.y,
    width: cardWidth,
    height: selection.height,
  }));
}

function analyzeRegion(imageData, region, settings = DEFAULT_DETECTOR_SETTINGS) {
  const insetX = Math.round(region.width * settings.sampleInset);
  const insetY = Math.round(region.height * settings.sampleInset);
  const left = clamp(Math.round(region.x + insetX), 0, imageData.width - 1);
  const top = clamp(Math.round(region.y + insetY), 0, imageData.height - 1);
  const right = clamp(Math.round(region.x + region.width - insetX), left + 1, imageData.width);
  const bottom = clamp(Math.round(region.y + region.height - insetY), top + 1, imageData.height);

  let count = 0;
  let saturationTotal = 0;
  let brightnessTotal = 0;
  let greyPixels = 0;
  const luminanceValues = [];

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * imageData.width + x) * 4;
      const r = imageData.data[offset];
      const g = imageData.data[offset + 1];
      const b = imageData.data[offset + 2];
      const hsl = rgbToHsl(r, g, b);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);

      count += 1;
      saturationTotal += hsl.saturation;
      brightnessTotal += luminance / 255;
      luminanceValues.push(luminance);
      if (hsl.saturation < settings.saturationThreshold || spread < 28) greyPixels += 1;
    }
  }

  if (!count) return { saturation: 0, contrast: 0, brightness: 0, greyRatio: 1, fadeScore: 1, dead: true };

  const saturation = saturationTotal / count;
  const brightness = brightnessTotal / count;
  const greyRatio = greyPixels / count;
  const mean = luminanceValues.reduce((sum, value) => sum + value, 0) / count;
  const variance = luminanceValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const contrast = Math.sqrt(variance);
  const saturationComponent = clamp((settings.saturationThreshold - saturation) / settings.saturationThreshold, 0, 1);
  const contrastComponent = clamp((settings.contrastThreshold - contrast) / settings.contrastThreshold, 0, 1);
  const greyComponent = clamp((greyRatio - 0.45) / 0.55, 0, 1);
  const brightnessComponent = clamp((brightness - 0.48) / 0.42, 0, 1);
  const fadeScore = clamp(saturationComponent * 0.38 + contrastComponent * 0.22 + greyComponent * 0.28 + brightnessComponent * 0.12, 0, 1);

  return { saturation, contrast, brightness, greyRatio, fadeScore, dead: fadeScore >= settings.fadeScoreThreshold };
}

function analyzePlayerCards(imageData, selection, settings = DEFAULT_DETECTOR_SETTINGS) {
  const mergedSettings = { ...DEFAULT_DETECTOR_SETTINGS, ...settings };
  return buildCardRegions(selection, mergedSettings.playerCount).map((region) => ({
    player: region.id,
    region,
    ...analyzeRegion(imageData, region, mergedSettings),
  }));
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_DETECTOR_SETTINGS, analyzePlayerCards, analyzeRegion, buildCardRegions, rgbToHsl };
}
