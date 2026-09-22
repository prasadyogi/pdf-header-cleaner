/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // These stay external to webpack's bundle on the server: pdfjs-dist and
    // xlsx are large, @napi-rs/canvas is a native addon, and tesseract.js
    // manages its own worker threads / wasm assets that don't survive bundling.
    serverComponentsExternalPackages: ["pdfjs-dist", "xlsx", "@napi-rs/canvas", "tesseract.js"],
    // pdf.js's Node "fake worker" mode locates its own pdf.worker.js file,
    // and tesseract.js/tesseract.js-core load their .wasm engine binaries
    // and worker scripts, both via dynamic (non-statically-analyzable)
    // requires at runtime. Vercel's automatic file tracing can't detect
    // those and omits them, so the function 500s ("Cannot find module
    // './pdf.worker.js'", then later ENOENT on the tesseract .wasm file)
    // unless we force them into the deployed function bundle.
    outputFileTracingIncludes: {
      "/api/convert": [
        "./node_modules/pdfjs-dist/**/*.js",
        "./node_modules/tesseract.js/dist/**",
        "./node_modules/tesseract.js-core/**",
      ],
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
