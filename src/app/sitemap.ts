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
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/research`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
  ];
};

export default sitemap;
