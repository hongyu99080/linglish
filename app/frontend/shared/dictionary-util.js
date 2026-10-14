(function(){
  if (typeof window === 'undefined') return;

  function readCookie(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch(_) { return null; }
  }

  function resolveToken() {
    const getters = [
      () => localStorage.getItem('linglish_token'),
      () => localStorage.getItem('authToken'),
      () => sessionStorage.getItem('linglish_token'),
      () => sessionStorage.getItem('authToken'),
    ];
    for (const g of getters) {
      try { const v = g(); if (v && v !== 'null' && v !== 'undefined') return v; } catch(_) {}
    }
    const candidates = ['linglish_token','authToken','token'];
    for (const n of candidates) { const v = readCookie(n); if (v) return v; }
    return null;
  }

  function headers() {
    const token = resolveToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function fetchEntry(baseUrl, word) {
    if (!word) return null;
    try {
      const r = await fetch(`${baseUrl || ''}/dictionary/${encodeURIComponent(String(word).toLowerCase())}`, { headers: headers() });
      if (!r.ok) return null; const j = await r.json(); return j && j.entry ? j.entry : null;
    } catch(_) { return null; }
  }

  function extractPhonetic(entry) {
    if (!entry) return '';
    let phon = entry.phonetic || '';
    if ((!phon || !phon.trim()) && Array.isArray(entry.phonetics)) {
      const p = entry.phonetics.find(p => p && (p.text || p.phonetic));
      phon = (p && (p.text || p.phonetic)) || '';
    }
    return (phon || '').trim();
  }

  async function fetchTranslation(baseUrl, word) {
    if (!word) return '';
    try {
      // Use unified dictionary API which includes translation in 'zh' field
      const r = await fetch(`${baseUrl || ''}/dictionary/${encodeURIComponent(String(word).toLowerCase())}`, { headers: headers() });
      if (!r.ok) return ''; const j = await r.json(); return j && j.zh || '';
    } catch(_) { return ''; }
  }

  window.DictionaryUtil = { resolveToken, fetchEntry, extractPhonetic, fetchTranslation };
})();

