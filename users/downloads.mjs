import { PLATFORMS } from './catalog.mjs';

// Public previews may be downloaded while live purchases remain disabled.
export function availableDownloads(manifest) {
  if (!['preview', 'released'].includes(manifest?.status)) return {};
  return Object.fromEntries(PLATFORMS.flatMap(platform => {
    const asset = manifest.assets?.[platform];
    try {
      const url = new URL(asset?.url);
      return url.protocol === 'https:' && !url.username && !url.password
        && /^[a-f\d]{64}$/.test(asset.sha256) && asset.tested === true ? [[platform, asset]] : [];
    } catch { return []; }
  }));
}
