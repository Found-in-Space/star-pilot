import { defineConfig } from 'vite';

const siteChrome = `
  <!-- 100% privacy-first analytics -->
  <script data-collect-dnt="true" async src="https://scripts.simpleanalyticscdn.com/latest.js"></script>
  <noscript><img src="https://queue.simpleanalyticscdn.com/noscript.gif?collect-dnt=true" alt="" referrerpolicy="no-referrer-when-downgrade" /></noscript>
  <footer class="fis-made-by-kaj" aria-label="Site credit">
    Made with <span aria-hidden="true">❤️</span> by <a href="https://k-si.com/">Kaj</a>
  </footer>
  <style>
    .fis-made-by-kaj {
      position: fixed; left: max(0.5rem, env(safe-area-inset-left)); bottom: max(0.5rem, env(safe-area-inset-bottom)); z-index: 2147483647;
      box-sizing: border-box; max-width: calc(100vw - 1rem); margin: 0; padding: 0.28rem 0.52rem; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 999px;
      color: rgba(255, 255, 255, 0.72); background: rgba(5, 8, 12, 0.76); box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.24);
      font: 500 0.72rem/1.35 system-ui, sans-serif; letter-spacing: 0.01em; white-space: nowrap; backdrop-filter: blur(8px); pointer-events: none;
    }
    .fis-made-by-kaj a { color: #9fbcff; text-decoration: none; pointer-events: auto; }
    .fis-made-by-kaj a:hover, .fis-made-by-kaj a:focus-visible { text-decoration: underline; }
    @media (min-width: 51.3125rem) {
      .fis-made-by-kaj { left: calc(340px + 0.5rem); }
    }
  </style>
`;

function analyticsAndCreditPlugin() {
  return {
    name: 'found-in-space-analytics-and-credit',
    transformIndexHtml(html: string) {
      return html.replace(/<\/body>/i, `${siteChrome}</body>`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [analyticsAndCreditPlugin()],
});
