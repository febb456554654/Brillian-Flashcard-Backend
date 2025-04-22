// lib/fetchImage.js
const axios = require('axios');

module.exports = async function fetchImage(keyword) {
  // DuckDuckGo’s undocumented JSON image endpoint
  // ‑ no API key needed but you must supply a realistic UA.
  const url = `https://duckduckgo.com/i.js?q=${encodeURIComponent(keyword)}&iax=images&ia=images`;
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 7000
  });
  if (data?.results?.length) {
    return data.results[0].image;          // full‑size url
    // or data.results[0].thumbnail
  }
  return null;
};
