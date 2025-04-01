import puppeteer from "puppeteer";

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto("https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListGuardrails.html");
  console.log(await page.title());
  await browser.close();
})();