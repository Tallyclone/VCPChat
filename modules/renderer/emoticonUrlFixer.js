// modules/renderer/emoticonUrlFixer.js

let emoticonLibrary = [];
let isInitialized = false;
let electronAPI;

// A simple string similarity function (Jaro-Winkler might be better, but this is simple)
function getSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) {
        return 1.0;
    }
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();

    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) {
            costs[s2.length] = lastValue;
        }
    }
    return costs[s2.length];
}


async function initialize(api) {
    if (isInitialized) return;
    electronAPI = api;
    try {
        console.log('[EmoticonFixer] Initializing and fetching library...');
        const library = await electronAPI.getEmoticonLibrary();
        if (library && library.length > 0) {
            emoticonLibrary = library;
            isInitialized = true;
            console.log(`[EmoticonFixer] Library loaded with ${emoticonLibrary.length} items.`);
        } else {
            console.warn('[EmoticonFixer] Fetched library is empty.');
        }
    } catch (error) {
        console.error('[EmoticonFixer] Failed to initialize:', error);
    }
}

function fixEmoticonUrl(originalSrc) {
    if (!isInitialized || emoticonLibrary.length === 0) {
        return originalSrc; // Not ready, pass through
    }

    // 1. Quick check: if the URL is already perfect, return it.
    // We decode both URLs to avoid mismatches due to encoding differences.
    try {
        const decodedOriginalSrc = decodeURIComponent(originalSrc);
        if (emoticonLibrary.some(item => decodeURIComponent(item.url) === decodedOriginalSrc)) {
            return originalSrc; // It's a perfect match, don't touch it.
        }
    } catch (e) {
        // If decoding fails, it's likely a malformed URL. Let it proceed to the fuzzy matching logic.
        console.warn(`[EmoticonFixer] Could not decode originalSrc: ${originalSrc}`, e);
    }

    // 2. Check if it's likely an emoticon URL. If not, pass through.
    // We check for "表情包" in the decoded URL path.
    try {
        const decodedSrc = decodeURIComponent(originalSrc);
        if (!decodedSrc.includes('表情包')) {
            return originalSrc;
        }
    } catch (e) {
        // URI malformed, likely not a valid URL we can fix anyway.
        return originalSrc;
    }


    // 3. Extract the filename from the original URL for matching.
    let searchFilename;
    try {
        // Robust way to get the last part of the path from a URL
        const decodedPath = decodeURIComponent(new URL(originalSrc).pathname);
        const parts = decodedPath.split('/');
        searchFilename = parts[parts.length - 1];
    } catch (e) {
        // Fallback for malformed URLs
        const match = decodeURIComponent(originalSrc).match(/([^/]+)$/);
        searchFilename = match ? match[1] : null;
    }
    
    if (!searchFilename) {
        return originalSrc;
    }

    // 4. Find the best match in the library.
    let bestMatch = null;
    let highestScore = 0.0;

    for (const item of emoticonLibrary) {
        const score = getSimilarity(searchFilename, item.filename);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = item;
        }
    }

    // 5. If we found a reasonably good match, return the fixed URL.
    // Lowered threshold to 0.6 to be more lenient.
    if (bestMatch && highestScore > 0.3) {
        console.log(`[EmoticonFixer] Fixed URL. Original: "${originalSrc}", Best Match: "${bestMatch.url}" (Score: ${highestScore})`);
        return bestMatch.url;
    }

    // 6. If no good match was found, return the original URL.
    console.log(`[EmoticonFixer] No suitable fix found for "${originalSrc}". Highest score: ${highestScore}. Passing through.`);
    return originalSrc;
}

export { initialize, fixEmoticonUrl };
