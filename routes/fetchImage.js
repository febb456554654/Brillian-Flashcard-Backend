const { image_search } = require('duckduckgo-images-api');

module.exports = async function fetchImage(keyword) {
  try {
    // returns an array of { image, thumbnail, title, url }
    const results = await image_search({ query: keyword, moderate: true, iterations: 1 });
    if (results.length) return results[0].image;   // full‑size URL
  } catch (e) {
    console.warn('fetchImage error:', e.message);
  }
  return null;
};