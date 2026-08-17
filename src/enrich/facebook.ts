// src/enrich/facebook.ts — Facebook Page intelligence extractor.
import type { Page } from 'patchright';
import type { BrowserManager } from '../browser.js';
import type { FacebookIntel } from './types.js';

const FB_TIMEOUT_MS = 25_000;

export async function scrapeFacebookPage(
  browserManager: BrowserManager,
  pageUrlOrName: string,
  options: { isUrl?: boolean } = {},
): Promise<FacebookIntel> {
  const result: FacebookIntel = { found: false };

  await browserManager.run(async (_ctx, page: Page) => {
    let targetUrl = pageUrlOrName.trim();
    if (!options.isUrl && !/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://www.facebook.com/search/pages/?q=${encodeURIComponent(targetUrl)}`;
    }

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: FB_TIMEOUT_MS });

      // If we landed on search results, click into first matching page
      if (page.url().includes('/search/pages/')) {
        await page.waitForTimeout(2000);
        const firstLink = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[role="presentation"], a[href*="facebook.com/"]'));
          for (const a of links) {
            const href = (a as HTMLAnchorElement).href;
            if (href && !href.includes('/search/') && !href.includes('/help/') && !href.includes('/login/')) {
              return href;
            }
          }
          return null;
        });

        if (firstLink) {
          await page.goto(firstLink, { waitUntil: 'domcontentloaded', timeout: FB_TIMEOUT_MS });
        } else {
          return;
        }
      }

      await page.waitForTimeout(2500);

      // Wait for the page NAME to render, not just the document.
      //
      // Signed out, FB puts the page name in the tab title, so a fixed pause was
      // enough. Signed in it does not: the title stays the notification counter plus
      // "Facebook" indefinitely, and the real name arrives only once the profile header
      // hydrates. A fixed 2.5s pause reached the evaluate before that happened, so the
      // stage reported "page did not resolve" on a page that was loading perfectly —
      // fixing the profile made this the next thing in the way.
      await page
        .waitForFunction(
          () =>
            !!document.querySelector('meta[property="og:title"]') ||
            /[\d.,]+[KkMm]?\s*followers/i.test(document.body?.innerText ?? ''),
          undefined,
          { timeout: 12_000 },
        )
        .catch(() => {
          // Fall through: the extraction below reports what it can see, which is more
          // useful than turning a slow header into a hard stage failure.
        });

      // Extract page metadata
      const data = await page.evaluate(() => {
        const text = document.body.innerText || '';

        // The page name, and NOT from document.title.
        //
        // Signed out, FB serves og:title and puts the name in the tab title. Signed in it
        // does neither: measured on this profile, the title was "(16) Facebook", there was
        // no og:title at all, and there was no h1 on the page. The name is only in an h2
        // and in the body text. So the anchor is the followers line — reliably present on
        // every page, with the name on the line directly above it.
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const followersLine = lines.findIndex((l) => /^[\d.,]+[KkMm]?\s*followers\b/i.test(l));
        const aboveFollowers = followersLine > 0 ? lines[followersLine - 1] : '';

        // h2 also holds the name, mixed in with the profile's section headings.
        const SECTIONS = /^(details|links|featured|posts|photos|reels|about|followers|following|reviews|intro|videos|mentions|more|explore)$/i;
        const h2Name = Array.from(document.querySelectorAll('h2'))
          .map((e) => (e.textContent ?? '').trim())
          .find((t) => t.length > 2 && t.length < 80 && !SECTIONS.test(t));

        const og = document
          .querySelector('meta[property="og:title"], meta[name="title"]')
          ?.getAttribute('content')
          ?.trim();
        const stripped = document.title
          .replace(/^\(\d+\+?\)\s*/, '') // notification counter
          .replace(/\s*\|\s*Facebook\s*$/i, '')
          .trim();

        // A bare "Facebook", a digit run, or the notification label is chrome, not a name.
        const usable = (s: string | undefined): string =>
          s && !/^facebook$/i.test(s) && !/^\d[\d.,]*$/.test(s) && !/unread notifications?/i.test(s) ? s : '';
        const title = usable(og) || usable(aboveFollowers) || usable(h2Name) || usable(stripped);

        // "100% recommend (7 reviews)" is how a Page shows its rating signed in — a
        // different shape from the star rating the logged-out view serves, so the
        // existing star/reviews regexes never matched it and both fields came back empty.
        const recommendMatch = text.match(/(\d{1,3})%\s*recommend\s*\((\d[\d,]*)\s*reviews?\)/i);
        const followingMatch = text.match(/([\d.,]+[KkMm]?)\s*following/i);

        // Followers / Likes regex
        const followersMatch = text.match(/([\d.,]+[KkMm]?)\s*followers/i);
        const likesMatch = text.match(/([\d.,]+[KkMm]?)\s*likes/i);
        const ratingMatch = text.match(/([\d.]+)\s*(?:stars?|out of 5)/i);
        const reviewsMatch = text.match(/([\d.,]+)\s*reviews/i);

        // Contact info in intro / details block
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const phoneMatch = text.match(/(?:\+?6?0)\d[\d\s-]{7,}\d/);
        
        // Messenger link
        const mLink = Array.from(document.querySelectorAll('a[href*="m.me/"], a[href*="messages/t/"]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .find(Boolean);

        // Verification badge check
        const hasVerifiedBadge = !!document.querySelector('svg[aria-label*="Verified" i], [aria-label*="Verified account" i]');

        // Are we signed in? A logged-out visitor still gets the page NAME and a
        // follower count, so the absence of a login wall is the only way to tell a
        // real read from a walled one. Checking the title alone passes the wall.
        const loginWall =
          !!document.querySelector('input[name="pass"], input[type="password"], form[action*="/login"]') ||
          /log in to continue|create new account|log into facebook/i.test(text.slice(0, 4000));

        // Intro / Bio snippet.
        //
        // Read positionally from the body text, not by scanning elements for the word
        // "About": that matched the navigation bar and produced the bio
        // "MoreAllAboutReelsPhotosFollowersMore…", which then went to NotebookLM as this
        // company's description. The real intro lines sit between the followers line and
        // the category, with only button labels in between.
        const CHROME = /^(message|follow|following|search|like|share|send message|contact|more|see all|·)$/i;
        const STOP = /^(all|about|reels|photos|followers|posts|videos|mentions|details|intro|reviews|links|featured)$/i;
        const introLines: string[] = [];
        for (let i = followersLine + 1; i < lines.length && introLines.length < 6; i++) {
          const l = lines[i];
          if (CHROME.test(l)) continue;
          if (STOP.test(l)) break;
          introLines.push(l);
        }
        const introBlock = introLines.join(' · ').slice(0, 400);

        return {
          pageName: title,
          followers: followersMatch ? followersMatch[1] : null,
          following: followingMatch ? followingMatch[1] : null,
          likes: likesMatch ? likesMatch[1] : null,
          rating: ratingMatch ? ratingMatch[1] : recommendMatch ? `${recommendMatch[1]}% recommend` : null,
          reviewsCount: recommendMatch
            ? parseInt(recommendMatch[2].replace(/,/g, ''), 10)
            : reviewsMatch
              ? parseInt(reviewsMatch[1].replace(/,/g, ''), 10)
              : undefined,
          messengerUrl: mLink || null,
          verified: hasVerifiedBadge,
          bio: introBlock || null,
          email: emailMatch ? emailMatch[0] : null,
          phone: phoneMatch ? phoneMatch[0] : null,
          currentUrl: window.location.href,
          loginWall,
        };
      });

      result.loggedIn = !data.loginWall;

      if (data.pageName && !data.pageName.includes('Log into Facebook')) {
        result.found = true;
        result.pageUrl = data.currentUrl;
        result.pageName = data.pageName;
        result.followers = data.followers || undefined;
        result.following = data.following || undefined;
        result.likes = data.likes || undefined;
        result.rating = data.rating || undefined;
        result.reviewsCount = data.reviewsCount;
        result.messengerUrl = data.messengerUrl || undefined;
        result.verified = data.verified;
        result.bio = data.bio || undefined;
        result.email = data.email || undefined;
        result.phone = data.phone || undefined;
      }
    } catch {
      // Soft failure if page is unreachable
    }
  });

  return result;
}
