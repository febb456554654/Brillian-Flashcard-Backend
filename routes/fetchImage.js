// lib/fetchImage.js
module.exports = async function fetchImage(keyword) {
    // Unsplash Source returns a random photo that matches the keyword.
    console.log('fetchImage called for', keyword)
    // No network request is made from your server; we just return the URL.
    return `https://source.unsplash.com/featured/800x600?${encodeURIComponent(keyword)}`;
  };
  