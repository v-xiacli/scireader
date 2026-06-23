import type { MetadataRoute } from 'next';

const getSiteUrl = () => {
  const value = process.env.NEXT_PUBLIC_APP_BASE_URL?.trim() || process.env.APP_BASE_URL?.trim();
  if (!value) return 'https://scireader.xyz';

  return /^https?:\/\//i.test(value) ? value.replace(/\/$/, '') : `https://${value.replace(/\/$/, '')}`;
};

const sitemap = (): MetadataRoute.Sitemap => {
  const siteUrl = getSiteUrl();
  const now = new Date();

  return [
    {
      url: siteUrl,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${siteUrl}/financial-analysis`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/research`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/ai-read-paper`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${siteUrl}/ai-paper-reading`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
    {
      url: `${siteUrl}/ai-stock-analysis`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.85,
    },
  ];
};

export default sitemap;
