export interface ScrapedPage {
  url: string;
  title?: string;
  markdown: string;
}

export interface Scraper {
  scrape(url: string): Promise<ScrapedPage>;
}
