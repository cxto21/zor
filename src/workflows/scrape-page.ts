import { workflow } from "libretto";

export default workflow("scrape-page", async ({ page }) => {
  await page.goto("https://example.com");
  const title = await page.title();
  console.log(`Page title: ${title}`);

  return { title };
});
