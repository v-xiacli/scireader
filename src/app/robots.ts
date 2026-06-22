import type { MetadataRoute } from 'next';

const getSiteUrl = () => {
  const value = process.env.NEXT_PUBLIC_APP_BASE_URL?.trim() || process.env.APP_BASE_URL?.trim();
  if (!value) return 'https://scireader.xyz';

  return /^https?:\/\//i.test(value) ? value.replace(/\/$/, '') : `https://${value.replace(/\/$/, '')}`;
};

const robots = (): MetadataRoute.Robots => ({
  rules: {
    userAgent: '*',
    allow: '/',
  },
  sitemap: `${getSiteUrl()}/sitemap.xml`,
});

export default robots;
