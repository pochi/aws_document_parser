import puppeteer from "puppeteer";
import { writeFileSync } from 'fs';

async function scrapingApiDocuments(urls: string[]) {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    for (const url of urls) {
      const page = await browser.newPage();
      await page.goto(url);
      console.log(`Title of ${url}:`, await page.title());
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

interface ApiOperation {
  name: string;
  link: string;
}

async function scrapeBedrockApiOperations(url: string): Promise<ApiOperation[]> {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.goto(url);

  await page.waitForSelector('.itemizedlist');

  const apiOperations = await page.evaluate(() => {
    const operations: ApiOperation[] = [];
    // 型を明示的に指定
    const listItems = Array.from(document.querySelectorAll('.itemizedlist li'));

    listItems.forEach((item: Element) => {
      const linkElement = item.querySelector('a');
      if (linkElement && linkElement.textContent && linkElement.href) {
        operations.push({
          name: linkElement.textContent.trim(),
          link: linkElement.href
        });
      }
    });

    return operations;
  });

  await browser.close();
  return apiOperations;
}

(async () => {
  try {
    const pages: Array<{ title: string, url: string }> = [
      { title: 'bedrock', url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock.html' },
      { title: 'bedrock_runtime', url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Amazon_Bedrock_Runtime.html' },
      { title: 'agents', url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Agents_for_Amazon_Bedrock.html' },
      { title: 'agents_runtime', url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Operations_Agents_for_Amazon_Bedrock_Runtime.html' },
    ];

    for (const page of pages) {
      const operations = await scrapeBedrockApiOperations(page['url']);
      console.log('取得したAPI操作一覧:' + page['title']);
      console.table(operations);
      writeFileSync('./output/api_list/' + page['title'] + '.json', JSON.stringify(operations, null, 2), 'utf-8');
    }
  } catch (error) {
    console.error('スクレイピング中にエラーが発生しました:', error);
  }
})();