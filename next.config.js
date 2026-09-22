/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // These stay external to webpack's bundle on the server: pdfjs-dist and
    // xlsx are large, @napi-rs/canvas is a native addon, and tesseract.js
    // manages its own worker threads / wasm assets that don't survive bundling.
    serverComponentsExternalPackages: ["pdfjs-dist", "xlsx", "@napi-rs/canvas", "tesseract.js"],
    // pdf.js's Node "fake worker" mode locates its own pdf.worker.js file at
    // runtime via a dynamic (non-statically-analyzable) require, so
    // Vercel's automatic file tracing misses it and the function 500s with
    // "Cannot find module './pdf.worker.js'" unless we force it in.
    outputFileTracingIncludes: {
      "/api/convert": ["./node_modules/pdfjs-dist/**/*.js"],
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // The browser pdf.js build references an optional `canvas` dependency
      // it never actually uses client-side; stub it out there only -- the
      // server route needs the real native `canvas` package for OCR rendering.
      config.resolve.alias.canvas = false;
    }
    return config;
  },
};

module.exports = nextConfig;
