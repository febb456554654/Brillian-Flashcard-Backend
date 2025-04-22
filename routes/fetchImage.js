// lib/fetchImage.js
require('dotenv').config();   // if you didn’t already load .env in server.js

const axios = require('axios');
const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

if (!ACCESS_KEY) {
  console.warn('⚠️  Missing UNSPLASH_ACCESS_KEY – images will be null');
}

module.exports = async function fetchImage(keyword) {
  if (!ACCESS_KEY) return null;

  try {
    const res = await axios.get('https://api.unsplash.com/search/photos', {
      params: {
        query: keyword,
        per_page: 1,
        orientation: 'landscape',
        content_filter: 'high'
      },
      headers: {
        Authorization: `Client-ID ${ACCESS_KEY}`
      },
      timeout: 5000
    });

    const photo = res.data.results[0];
    return photo?.urls?.regular || null;
  } catch (err) {
    console.warn('fetchImage (Unsplash) failed for:', keyword, err.message);
    return null;
  }
};
