const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');

const TARGET_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

// "$299.99" -> 299.99, anything else -> null
function parsePrice(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function toAbsolute(href, base) {
  try {
    return href ? new URL(href, base).toString() : null;
  } catch {
    return null;
  }
}

async function extract(page) {
  return page.evaluate(() => {
    // Title: breadcrumb active item
    const title = document.querySelector('ol.breadcrumb li.active')?.textContent?.trim() || null;

    const crumbs = [...document.querySelectorAll('ol.breadcrumb a')]
      .map((a) => ({ name: (a.textContent || '').trim(), url: a.getAttribute('href') || null }))
      .filter((c) => c.name && !/^home$/i.test(c.name));

    const description =
      document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
      document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || null;

    const priceMatch = (document.body.innerText || '').match(/\$\s?[\d,]+\.\d{2}/);

    const btn = document.querySelector('button[name="add"], #AddToCart, .add-to-cart');
    const availability = btn && !btn.disabled ? 'in_stock' : 'out_of_stock';

    // Gallery: main #imagePopup + thumb popup_img
    const main = document.querySelector('#imagePopup')?.getAttribute('src') || null;
    const thumbs = [...document.querySelectorAll('img.product-detail-thumb-bto')]
      .map((img) => img.getAttribute('popup_img') || img.getAttribute('src'))
      .filter(Boolean);

    // Specs: plain key-value table rows
    const specs = [];
    document.querySelectorAll('table tr').forEach((tr) => {
      const cells = [...tr.querySelectorAll('th, td')].map((c) => (c.innerText || '').trim());
      if (cells.length >= 2 && cells[0] && cells[1] && cells[0].length < 80) {
        specs.push({ name: cells[0], value: cells[1] });
      }
    });

    // Reviews tab is JS-loaded; "#average-rating-info"
    const avg = document.querySelector('#average-rating-info')?.textContent || '';
    const rm = avg.match(/([\d.]+)\s*\((\d+)\)/);

    const mpnRow = specs.find((s) => /manufacturer number|mpn|part number/i.test(s.name));

    return {
      title, crumbs, description,
      priceRaw: priceMatch ? priceMatch[0] : null,
      availability, main, thumbs,
      specs: specs.slice(0, 60),
      star: rm ? rm[1] : null,
      reviewCount: rm ? rm[2] : null,
      mpn: mpnRow ? mpnRow.value : null,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({});
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const tab = page.locator('a[href="#tab-review"], a[href="#review"]');
    if (await tab.count()) await tab.first().click().catch(() => {});
    await page.waitForSelector('#average-rating-info', { timeout: 15000 }).catch(() => {});

    const url = page.url();
    const d = await extract(page);

    const category_tree = d.crumbs.map((c) => ({ name: c.name, url: toAbsolute(c.url, url) }));
    const gallery = [...new Set([d.main, ...d.thumbs].filter(Boolean))];

    const item_id = url.split('?')[0].split('/').filter(Boolean).pop() || null;

    const result = {
      url,
      item_id,
      title: d.title,
      brand: 'MSI',
      product_category: category_tree.length ? category_tree.map((c) => c.name).join(' > ') : null,
      category_tree,
      description: d.description,
      price: parsePrice(d.priceRaw),
      sale_price: null, // no discount shown on this page
      availability: d.availability,
      image_url: gallery[0] || null,
      additional_image_urls: gallery.slice(1),
      specs: d.specs,
      star_rating: d.star ? Number(d.star) : null,
      review_count: d.reviewCount ? Number(d.reviewCount) : null,
      gtin: null, // page exposes no barcode/UPC
      mpn: d.mpn,
      scraped_at: new Date().toISOString(),
    };

    const outPath = path.join(__dirname, '..', 'output', 'product.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log('Saved to', outPath);
  } catch (err) {
    console.error('Scrape failed:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
