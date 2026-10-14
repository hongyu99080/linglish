/**
 * Vocabulary & Catalog Management Module
 * Handles media, segments, and library content loading
 */

import { state, debugLog } from './state.js';
import { apiFetch } from './api.js';

/**
 * Load media catalog and segments from the API
 */
export async function loadCatalog() {
  try {
    const [mediaResponse, segmentsResponse] = await Promise.all([
      apiFetch('/media').catch(() => ({ items: [] })),
      apiFetch('/segments').catch(() => ({ items: [] })),
    ]);

    state.media = (mediaResponse && mediaResponse.items) || [];
    state.segments = (segmentsResponse && segmentsResponse.items) || [];
    populateMediaSelectors();
  } catch (err) {
    console.error('Failed to load catalog:', err);
    state.media = [];
    state.segments = [];
  }
}

/**
 * Populate media selector dropdowns with available media
 */
export function populateMediaSelectors() {
  const shadowSelect = document.getElementById('shadowing-media');
  const dictoglossSelect = document.getElementById('dictogloss-media');

  // Check if elements exist (they may not exist on all pages)
  if (!shadowSelect && !dictoglossSelect) {
    debugLog('[populateMediaSelectors] Training module elements not found, skipping');
    return;
  }

  [shadowSelect, dictoglossSelect].filter(Boolean).forEach((select) => {
    const frag = document.createDocumentFragment();
    state.media.forEach((media) => {
      const option = document.createElement('option');
      option.value = media.id;
      const matchingArticle = media.article_id
        ? `Article #${media.article_id}`
        : 'Standalone media';
      option.textContent = `${matchingArticle} — ${media.kind.toUpperCase()}`;
      frag.appendChild(option);
    });
    select.innerHTML = '';
    select.appendChild(frag);
  });

  if (state.media.length) {
    if (shadowSelect) shadowSelect.dispatchEvent(new Event('change'));
    if (dictoglossSelect) dictoglossSelect.dispatchEvent(new Event('change'));
  }
}

/**
 * Load library counts (PDFs, articles, videos)
 */
export async function loadLibraryCounts() {
  try {
    const [articlesRes, videosRes] = await Promise.all([
      apiFetch('/articles').catch(() => ({ items: [] })),
      apiFetch('/video-resources?lite=1').catch(() => ({ items: [] }))
    ]);

    const articles = articlesRes.items || articlesRes.articles || [];
    const videos = videosRes.items || [];

    const pdfCount = articles.filter(a => a.source_type === 'pdf').length;
    const textCount = articles.filter(a => a.source_type !== 'pdf').length;
    const videoCount = videos.length;

    const formatCount = (count, unit = 'items') => {
      if (typeof count !== 'number') return '';
      const suffix = unit === 'items'
        ? `${count === 1 ? 'item' : 'items'}`
        : unit;
      return `${count} ${suffix}`.trim();
    };

    const assignText = (id, text) => {
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el.textContent !== text) {
        el.textContent = text;
      }
    };

    assignText('pdf-count', formatCount(pdfCount));
    assignText('article-count', formatCount(textCount));
    assignText('video-count', formatCount(videoCount));

    // Optional extended cards present on some layouts
    assignText('total-articles', String(articles.length));
    assignText('total-videos', String(videoCount));

    // Import here to avoid circular dependency
    const { renderVideoLibraryList } = await import('./ui-manager.js');
    renderVideoLibraryList(videos);

  } catch (err) {
    console.error('Failed to load library counts:', err);
  }
}
