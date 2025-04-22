// lib/fetchImage.js
require('dotenv').config(); // only if you rely on a local .env in dev

const axios = require('axios');
const API_KEY = process.env.GOOGLE_API_KEY;
const CX      = process.env.GOOGLE_CX;

if (!API_KEY || !CX) {
  console.warn('⚠️ Missing GOOGLE_API_KEY or GOOGLE_CX – images will be null');
}

module.exports = async function fetchImage(keyword) {
  if (!API_KEY || !CX) return null;

  try {
    const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key:       API_KEY,
        cx:        CX,
        q:         keyword,
        searchType:'image',
        num:       1,
        safe:      'high',         // filter adult content
        imgType:   'photo',        // get photos, not clip art
        imgSize:   'medium',       // a good mid‑size image
      },
      timeout: 5000,
    });

    const item = res.data.items?.[0];
    return item?.link || null;
  } catch (err) {
    console.warn('fetchImage (Google CSE) error for', keyword, err.message);
    return null;
  }
};
