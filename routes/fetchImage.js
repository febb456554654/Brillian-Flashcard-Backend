// lib/fetchImage.js
module.exports = async function fetchImage(keyword) {
    // Unsplash Source returns a 302 redirect directly to a photo that
    // matches the keyword. No API key, no rate‑limit headaches.
    return `https://source.unsplash.com/featured/800x600?${encodeURIComponent(keyword)}&sig=${id}`;
  };
  