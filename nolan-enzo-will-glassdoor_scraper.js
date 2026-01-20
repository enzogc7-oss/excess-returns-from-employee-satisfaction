/**
 * GLASSDOOR SCRAPER (Search-First + Persistent Session)
 * ------------------------------------------------
 * 1. Uses a "Persistent Context" to save login.
 * 2. SEARCHES for each company manually to avoid bad link redirects.
 * 3. Scrapes data using TEXT CONTENT matching (Pros/Cons) to bypass dynamic classes.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const OUTPUT_FILE = 'glassdoor_data.json';
const DEBUG_DIR = 'debug_images'; // Folder for screenshots to debug
const MAX_PAGES_PER_COMPANY = 30; // ~300 reviews/company

// TOP 20 ALBERTA OIL & GAS COMPANIES (Publicly Traded)
const TARGET_COMPANIES = [
    'Enbridge',
    'Canadian Natural Resources',
    'Suncor Energy',
    'TC Energy',
    'Cenovus Energy',
    'Imperial Oil',
    'Pembina Pipeline',
    'Tourmaline Oil',
    'ARC Resources',
    'MEG Energy',
    'Whitecap Resources',
    'Strathcona Resources', 
    'Keyera',
    'Gibson Energy',
    'Vermilion Energy',
    'Baytex Energy',
    'Paramount Resources',
    'Peyto Exploration & Development',
    'Athabasca Oil',
    'NuVista Energy'
];

function saveData(newData) {
    let existing = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        try { existing = JSON.parse(fs.readFileSync(OUTPUT_FILE)); } catch (e) {}
    }
    const combined = [...existing, ...newData];
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(combined, null, 2));
}

// Ensure debug directory exists
if (!fs.existsSync(DEBUG_DIR)) {
    fs.mkdirSync(DEBUG_DIR);
}

// RESET DATA FILE (Critical to prevent reading old/empty data)
if (fs.existsSync(OUTPUT_FILE)) {
    try { fs.unlinkSync(OUTPUT_FILE); console.log("Deleted old data file."); } catch(e) {}
}

async function scrapeGlassdoor() {
    // FOLDER TO STORE LOGIN DATA
    const userDataDir = 'glassdoor_auth';

    console.error("--- LAUNCHING BROWSER ---");
    
    // USE PERSISTENT CONTEXT
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1920, height: 1080 }, // Desktop resolution
        args: [
            '--disable-blink-features=AutomationControlled', 
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-position=0,0'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // FIX: Reuse the default page instead of closing it
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    // STEP 1: Go to Homepage
    console.error("1. Navigating to Glassdoor Homepage...");
    try {
        await page.goto('https://www.glassdoor.ca/index.htm', { timeout: 60000, waitUntil: 'domcontentloaded' });
    } catch (e) {
        console.error("   ! Error loading homepage. You might be IP blocked.");
    }

    // Check blocked status
    const title = await page.title();
    if (title.includes("Access Denied") || title.includes("Cloudflare")) {
        console.error("--- BLOCKED BY FIREWALL ---");
        console.error("Please manually solve the CAPTCHA now.");
        await page.waitForTimeout(30000); 
    }

    // STEP 2: Check Login State
    console.error("2. Checking Login Status...");
    await page.waitForTimeout(3000);

    const isLoginPage = page.url().includes('login') || page.url().includes('signin') || page.url().includes('Account');
    
    if (isLoginPage) {
        console.error("--- LOGIN REQUIRED ---");
        console.error("   Please manually click 'Sign In' (top right) and log in.");
        console.error("   Waiting up to 120 seconds...");
        
        try {
            await page.waitForFunction(() => {
                const url = window.location.href;
                return !url.includes('login') && !url.includes('signin') && !url.includes('Account');
            }, null, { timeout: 120000 });
            console.error("--- Login Detected! ---");
            await page.waitForTimeout(3000); 
        } catch (e) {
            console.error("--- Timeout waiting for login. Attempting to proceed... ---");
        }
    } else {
        console.error("--- ALREADY LOGGED IN (Session Loaded) ---");
    }

    // SCRAPING LOOP (SEARCH BASED)
    for (const companyName of TARGET_COMPANIES) {
        console.error(`\nTargeting: ${companyName}`);
        
        try {
            // A. Go to Reviews Search Page
            await page.goto('https://www.glassdoor.ca/Reviews/index.htm', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);

            // B. Type Company Name
            console.error(`   Searching for "${companyName}"...`);
            
            // FIX: Handle the Search Button/Input Interception
            const searchButtonTrigger = page.locator('button[data-test="search-button"]').first();
            const searchInput = page.locator('input[data-test="search-bar-keyword-input"], input[id="sc.keyword"], input[placeholder*="Company"]').first();
            
            // 1. Click the "fake" button if it exists to activate the field
            if (await searchButtonTrigger.isVisible()) {
                 await searchButtonTrigger.click();
                 await page.waitForTimeout(500);
            }

            // 2. Force click the input (bypasses any remaining overlays)
            if (await searchInput.isVisible()) {
                await searchInput.click({ force: true });
                await searchInput.fill('');
                await searchInput.fill(companyName);
                await page.waitForTimeout(500);
                
                // 3. Submit
                const submitBtn = page.locator('button[data-test="search-bar-submit"], button[type="submit"]').first();
                if (await submitBtn.isVisible()) {
                    await submitBtn.click();
                } else {
                    await page.keyboard.press('Enter');
                }
                
                // --- RESULT SELECTION FIX ---
                console.error("   Waiting for search results...");
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(3000); 

                // Based on screenshots, we have a "Companies" header and cards below it.
                // We want to grab the HREF and navigate manually to avoid "new tab" issues.
                
                let targetUrl = null;
                const firstWord = companyName.split(' ')[0]; // "Suncor", "Canadian", etc.

                try {
                    // Strategy 1: Find a Heading or Link with the exact company name text
                    const exactLink = page.getByRole('link', { name: companyName, exact: false }).first();
                    
                    // Strategy 2: Find a link starting with the first word
                    const partialLink = page.getByRole('link', { name: firstWord, exact: false }).first();

                    // Strategy 3: Find image link
                    const logoLink = page.locator('div#MainCol a:has(img)').first();

                    if (await exactLink.isVisible()) {
                        targetUrl = await exactLink.getAttribute('href');
                        console.error(`   Found exact match URL: ${targetUrl}`);
                    } else if (await partialLink.isVisible()) {
                        targetUrl = await partialLink.getAttribute('href');
                        console.error(`   Found partial match URL: ${targetUrl}`);
                    } else if (await logoLink.isVisible()) {
                        targetUrl = await logoLink.getAttribute('href');
                        console.error(`   Found logo URL: ${targetUrl}`);
                    }
                } catch(err) {
                    console.error("   Link finding failed: " + err.message);
                }

                if (targetUrl) {
                    // FIX: Ensure URL is absolute before navigating
                    if (targetUrl.startsWith('/')) {
                        targetUrl = `https://www.glassdoor.ca${targetUrl}`;
                    }
                    
                    console.error(`   Navigating to Company Page: ${targetUrl}`);
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                } else {
                    console.error("   ! Could not identify a result. Saving screenshot.");
                    const shotPath = path.join(DEBUG_DIR, `debug_results_missing_${companyName.replace(/\s/g, '')}.png`);
                    await page.screenshot({ path: shotPath });
                    continue;
                }

                await page.waitForTimeout(3000);
                
                // E. Ensure we are on the REVIEWS tab
                // CRITICAL FIX: Don't pick the link if it goes to "Reviews/index.htm" (that's the global nav)
                if (!page.url().includes('Reviews') || page.url().includes('Overview')) {
                    console.error("   Switching to Reviews tab...");
                    
                    // Get all potential review links
                    const reviewLinks = await page.locator('a[href*="/Reviews/"], a[data-test="review-tab"]').all();
                    let validReviewUrl = null;

                    for (const link of reviewLinks) {
                        const href = await link.getAttribute('href');
                        if (href && !href.includes('Reviews/index.htm') && href.includes('Reviews-E')) {
                            validReviewUrl = href;
                            break; // Found the specific company review link
                        }
                    }
                    
                    if (validReviewUrl) {
                        if (validReviewUrl.startsWith('/')) {
                            validReviewUrl = `https://www.glassdoor.ca${validReviewUrl}`;
                        }
                        console.error(`   Navigating to Reviews URL: ${validReviewUrl}`);
                        await page.goto(validReviewUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(2000);
                    } else {
                        console.error("   ! Could not find specific Company Reviews tab. Staying on current page.");
                    }
                }

            } else {
                console.error("   ! Could not find search input. Skipping.");
                await page.screenshot({ path: path.join(DEBUG_DIR, `debug_no_search_input.png`) });
                continue;
            }

        } catch (e) {
            console.error(`   ! Search failed for ${companyName}: ${e.message}`);
            try { 
                await page.screenshot({ path: path.join(DEBUG_DIR, `debug_search_fail_${companyName.replace(/\s/g, '')}.png`) }); 
            } catch(err) {
                console.error("   ! Screenshot failed: " + err.message);
            }
            continue;
        }
        
        // D. SCRAPE PAGES
        for (let i = 0; i < MAX_PAGES_PER_COMPANY; i++) {
            console.error(`   Scraping Page ${i + 1}...`);
            
            // FIX: Scroll DEEPER to skip the "Highlights" section
            await page.evaluate(() => window.scrollBy(0, 4000));
            await page.waitForTimeout(3000 + Math.random() * 2000); 

            // Expand Text
            try {
                const showMoreButtons = await page.locator('div[class*="continueReading"], button.showMore').all();
                for (const btn of showMoreButtons) {
                    if (await btn.isVisible()) {
                        await btn.click(); 
                        await page.waitForTimeout(200); 
                    }
                }
            } catch (e) {}

            // Extract Data - UPDATED WITH TEXT-BASED EXTRACTION
            const reviews = await page.$$eval('*', (allItems) => {
                // INTERNAL HELPER TO EXTRACT DATA
                // We define it inside the browser context
                const parseReviewCard = (card) => {
                    const text = card.innerText || "";
                    
                    // FILTER GARBAGE:
                    if (text.includes("(in ") && text.includes("reviews)")) return null;
                    if (text.length < 50) return null;
                    if (!text.includes("Star") && !card.querySelector('.ratingNumber') && !card.querySelector('span[class*="rating"]')) return null;

                    // Helper to get block of text between keywords
                    const getSection = (startKeyword, endKeywords) => {
                        if (!text.includes(startKeyword)) return null;
                        
                        let startIndex = text.indexOf(startKeyword) + startKeyword.length;
                        let endIndex = text.length;

                        // Find the nearest end keyword
                        for (const key of endKeywords) {
                            const idx = text.indexOf(key, startIndex);
                            if (idx !== -1 && idx < endIndex) {
                                endIndex = idx;
                            }
                        }
                        
                        return text.substring(startIndex, endIndex).replace(/[:\-\.]/g, '').trim();
                    };

                    // Try to find rating
                    let rating = null;
                    const ratingEl = card.querySelector('.ratingNumber') || card.querySelector('span[class*="rating"]');
                    if (ratingEl) rating = ratingEl.innerText.trim();
                    if (!rating) {
                        const match = text.match(/^[0-5]\.\d/);
                        if (match) rating = match[0];
                    }

                    // Extract Date explicitly using Regex (e.g. "Nov 28, 2025")
                    let date = null;
                    // Regex looks for "Month DD, YYYY" pattern
                    const dateMatch = text.match(/([A-Z][a-z]{2,9}\s\d{1,2},\s\d{4})/);
                    if (dateMatch) {
                        date = dateMatch[1];
                    }

                    // Extract Title (Clickable link usually)
                    let title = null;
                    const link = card.querySelector('a[href*="/Reviews/Employee-Review"]');
                    if (link) {
                        title = link.innerText.trim();
                    }

                    // Extract Job Title / Status (e.g. "Current Employee")
                    // Usually appears right after the date text
                    let jobTitle = null;
                    if (date) {
                        // Find text line containing the date
                        const lines = text.split('\n');
                        const dateLine = lines.find(l => l.includes(date));
                        if (dateLine) {
                            // Often looks like "Nov 28, 2025 - Current Employee - Engineer"
                            jobTitle = dateLine.replace(date, '').replace(/^[\s\-\|]+/, '').trim();
                        }
                    }

                    // Extract Pros / Cons using keyword boundaries
                    let pros = getSection('Pros', ['Cons', 'Advice to Management', 'Helpful']);
                    let cons = getSection('Cons', ['Advice to Management', 'Helpful']);
                    let advice = getSection('Advice to Management', ['Helpful']);

                    // Only return if valid review
                    if (rating && (pros || cons || title)) {
                        return { rating, date, title, job_title: jobTitle, pros, cons, advice };
                    }
                    return null;
                };

                // 1. Try "Li" elements first (Standard)
                let candidates = Array.from(document.querySelectorAll('li'));
                
                // 2. If filtering yields nothing, try "Divs" with specific text (Fallback)
                let results = candidates.map(parseReviewCard).filter(r => r !== null);

                if (results.length === 0) {
                    const divs = Array.from(document.querySelectorAll('div'));
                    const reviewDivs = divs.filter(d => d.innerText.includes('Pros') && d.innerText.includes('Cons') && d.innerText.length < 2000);
                    const uniqueDivs = reviewDivs.filter(d => !reviewDivs.some(other => other !== d && other.contains(d)));
                    results = uniqueDivs.map(parseReviewCard).filter(r => r !== null);
                }

                return results;
            });

            if (reviews.length === 0) {
                console.error("   ! No reviews found. Saving HTML debug file.");
                try { 
                    await page.screenshot({ path: path.join(DEBUG_DIR, `debug_${companyName.replace(/\s/g, '')}_failed.png`) }); 
                    const html = await page.content();
                    fs.writeFileSync(path.join(DEBUG_DIR, `debug_${companyName.replace(/\s/g, '')}.html`), html);
                } catch(err) {
                    console.error("   ! Screenshot/HTML failed: " + err.message);
                }
            } else {
                const cleanReviews = reviews.map(r => ({ company: companyName, ...r }));
                saveData(cleanReviews);
                console.error(`   + Found ${cleanReviews.length} reviews.`);
            }

            // Next Page
            try {
                // Scroll to bottom to ensure pagination is loaded/visible
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(2000);

                // FIX: More robust pagination locator
                const nextButton = page.locator('button[data-test="pagination-next"], a[data-test="pagination-next"], button[aria-label="Next"], span[aria-label="Next"], a.nextButton').first();
                
                if (await nextButton.count() === 0) {
                    console.error("   Next button selector matched nothing.");
                    await page.screenshot({ path: path.join(DEBUG_DIR, `debug_no_next_button_${companyName.replace(/\s/g, '')}_page${i}.png`) });
                    break;
                }

                // Check if button is enabled/visible
                // Sometimes glassdoor uses a class "disabled" instead of the attribute
                const isVisible = await nextButton.isVisible();
                const isDisabled = await nextButton.isDisabled();
                const classList = await nextButton.getAttribute('class') || "";
                const isClassDisabled = classList.includes('disabled');

                if (!isVisible) {
                    console.error("   Next button hidden.");
                    break;
                }

                if (isDisabled || isClassDisabled) {
                    console.error(`   Reached end of reviews for ${companyName}.`); // SAFEGUARD LOG
                    break;
                }

                console.error("   Clicking Next...");
                
                // Ensure it's in view
                await nextButton.scrollIntoViewIfNeeded();
                await nextButton.click({ force: true });
                await page.waitForTimeout(4000 + Math.random() * 3000);
            } catch (e) { 
                console.error(`   Pagination error: ${e.message}`);
                break; 
            }
        }
    }

    await context.close();
    console.error("--- Scraper Finished ---");
}

scrapeGlassdoor();