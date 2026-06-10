import Firecrawl from '@mendable/firecrawl-js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { ScrapedPage, Scraper } from './types.js';

export function createFirecrawlScraper(): Scraper {
  if (!env.FIRECRAWL_API_KEY) {
    throw new AppError('FIRECRAWL_API_KEY is not configured', {
      code: 'scraper_unconfigured',
      statusCode: 503,
    });
  }
  const client = new Firecrawl({ apiKey: env.FIRECRAWL_API_KEY });
  return {
    async scrape(url: string): Promise<ScrapedPage> {
      const doc = await client.scrape(url, { formats: ['markdown'] });
      const metadata = doc.metadata as Record<string, unknown> | undefined;
      const title = typeof metadata?.title === 'string' ? metadata.title : undefined;
      return { url, title, markdown: doc.markdown ?? '' };
    },
  };
}
